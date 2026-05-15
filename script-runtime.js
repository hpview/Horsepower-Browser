/**
 * Phase D · ScriptRuntime
 *
 * 沙箱化的 JavaScript 执行环境（renderer / webview / main 三 target）。
 *
 * 安全策略：
 *   - 用 AsyncFunction(args, code) 构造，参数列表显式控制可见性
 *   - 不向用户代码注入 require / process / eval / Function / electronAPI 直接面
 *   - 注入受控 `api` 对象（白名单见 ScriptRuntimeConfig.apiSurface）
 *   - 30s 硬超时
 *   - logs 与 result 长度限制
 *
 * 注：JS 沙箱无法做到强加密隔离（同 realm 仍可通过原型链访问全局），
 *     这里的 sandbox 主要用于 **降低误用面、规范调用方式**，而非抵御恶意攻击。
 *     真正的恶意防御应在用户主动安装 skill 前做出"明确确认对话框"。
 */

(function (global) {
    'use strict';

    const CFG = () => global.AgentV2?.ScriptRuntimeConfig || {};

    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;

    function _buildApi() {
        const api = global.electronAPI;
        if (!api) return null;
        const cfg = CFG().apiSurface || {};
        const out = {};
        for (const ns of Object.keys(cfg)) {
            const allowed = new Set(cfg[ns]);
            if (ns === 'util' || ns === 'paths') continue; // 由 runtime 自生
            const src = api[ns];
            if (!src) continue;
            out[ns] = {};
            for (const k of allowed) {
                if (typeof src[k] === 'function') out[ns][k] = src[k].bind(src);
            }
        }
        // util 内置（不走 IPC）
        if ((cfg.util || []).length) {
            out.util = {};
            const u = new Set(cfg.util);
            if (u.has('sleep')) out.util.sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, +ms || 0)));
            if (u.has('uuid')) out.util.uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
            if (u.has('hash')) out.util.hash = async (str) => {
                const data = new TextEncoder().encode(String(str));
                const buf = await crypto.subtle.digest('SHA-256', data);
                return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            };
        }
        // paths 内置 —— 走 IPC 拿 userData，本地缓存
        if ((cfg.paths || []).length) {
            out.paths = _buildPathsApi(api, new Set(cfg.paths));
        }
        return out;
    }

    /** paths helper：基于 cfg.paths.relativeBase 解析相对路径 */
    function _buildPathsApi(api, allowed) {
        const cfgPaths = CFG().paths || {};
        // 平台路径分隔符（renderer 不直接 require('path')，自己实现极简版）
        const sep = (typeof navigator !== 'undefined' && /Win/.test(navigator.platform)) ? '\\' : '/';
        const isAbs = (p) => /^([a-zA-Z]:[\\/]|[\\/])/.test(String(p));
        const join = (...parts) => parts.filter(Boolean).map(p => String(p).replace(/[\\/]+$/, '')).join(sep);
        const out = {};
        // 缓存 userData 路径
        let _userDataCache = null;
        const _userData = async () => {
            if (_userDataCache) return _userDataCache;
            try {
                if (api.app?.getPath) _userDataCache = await api.app.getPath('userData');
                else if (api.system?.getUserDataPath) _userDataCache = await api.system.getUserDataPath();
                else if (api.skills?.rootDir) {
                    // skill-store 提供了 root-dir IPC，反推 userData
                    const r = await api.skills.rootDir();
                    _userDataCache = String(r || '').replace(/[\\/]aiview-data[\\/]skills[\\/]?$/, '');
                }
            } catch (_) { _userDataCache = null; }
            return _userDataCache;
        };
        if (allowed.has('userData')) out.userData = async (...sub) => {
            const root = await _userData();
            return root ? join(root, ...sub) : null;
        };
        if (allowed.has('skillData')) out.skillData = async (...sub) => {
            const root = await _userData();
            if (!root) return null;
            return join(root, 'aiview-data', cfgPaths.skillDataSubdir || 'skill-data', ...sub);
        };
        if (allowed.has('workspace')) out.workspace = async (...sub) => {
            // 当前活动 tab 的目录
            try {
                const tabs = await api.tabs?.list?.();
                const active = (tabs || []).find(t => t.active) || (tabs || [])[0];
                if (active?.path) {
                    const dir = String(active.path).replace(/[\\/][^\\/]*$/, '');
                    return join(dir, ...sub);
                }
            } catch (_) { /* ignore */ }
            return await out.userData?.(...sub);
        };
        if (allowed.has('join')) out.join = (...parts) => join(...parts);
        if (allowed.has('resolve')) out.resolve = async (p) => {
            if (!p) return null;
            if (isAbs(p)) return p;
            const base = (cfgPaths.relativeBase || 'workspace');
            const fn = out[base] || out.userData;
            return fn ? await fn(p) : p;
        };
        return out;
    }

    function _captureConsole(maxLines, maxChars) {
        const lines = [];
        const push = (level, args) => {
            if (lines.length >= maxLines) return;
            try {
                const text = args.map(a => {
                    if (typeof a === 'string') return a;
                    try { return JSON.stringify(a); } catch { return String(a); }
                }).join(' ');
                lines.push(`[${level}] ${text.slice(0, maxChars)}`);
            } catch (_) { /* ignore */ }
        };
        return {
            console: {
                log: (...a) => push('log', a),
                warn: (...a) => push('warn', a),
                error: (...a) => push('error', a),
                info: (...a) => push('info', a),
            },
            getLogs: () => lines.slice(),
        };
    }

    /**
     * 在 renderer 内沙箱执行
     * @param {string} code  脚本源码（async 函数体）
     * @param {object} args  入参对象（注入为 globalThis.args）
     */
    async function runRendererCode(code, args) {
        const cfg = CFG().sandbox || {};
        const timeoutMs = cfg.timeoutMs || 30000;
        const cap = _captureConsole(cfg.maxLogLines || 200, cfg.maxLogChars || 2000);
        const apiObj = _buildApi();
        const startedAt = Date.now();

        const fn = new AsyncFunction('api', 'args', 'console', `'use strict';\n${code}`);

        const exec = (async () => {
            const result = await fn(apiObj, args || {}, cap.console);
            return result;
        })();

        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`script timeout after ${timeoutMs}ms`)), timeoutMs));

        try {
            const result = await Promise.race([exec, timeout]);
            return _serialize({
                success: true,
                result,
                logs: cap.getLogs(),
                elapsedMs: Date.now() - startedAt,
            });
        } catch (e) {
            return {
                success: false,
                error: e?.message || String(e),
                stack: e?.stack || null,
                logs: cap.getLogs(),
                elapsedMs: Date.now() - startedAt,
            };
        }
    }

    /** 在 webview 内执行（基于 _runInWebview），返回值 JSON 序列化 */
    async function runWebviewCode(code, args) {
        const tm = global.tabManager;
        const tab = tm?.getActiveTab?.() || tm?.tabs?.find(t => t.active);
        if (!tab) return { success: false, error: 'webview target: 未找到活动浏览器标签' };
        const wv = tm._webviews?.get?.(tab.id) || tab._webview;
        if (!wv || typeof wv.executeJavaScript !== 'function') {
            return { success: false, error: 'webview target: 未找到 webview' };
        }
        const wrapped = `(async function(){
            const args = ${JSON.stringify(args || {})};
            try {
                const __r = await (async () => { ${code} })();
                return JSON.stringify({ success: true, result: __r });
            } catch (e) {
                return JSON.stringify({ success: false, error: e?.message || String(e) });
            }
        })()`;
        try {
            const raw = await wv.executeJavaScript(wrapped, true);
            try { return JSON.parse(raw); } catch { return { success: true, result: raw }; }
        } catch (e) {
            return { success: false, error: e?.message || String(e) };
        }
    }

    function _serialize(obj) {
        const cfg = CFG().sandbox || {};
        const max = cfg.maxResultChars || 50 * 1024;
        try {
            const json = JSON.stringify(obj.result);
            if (json && json.length > max) {
                return { ...obj, result: json.slice(0, max), _truncated: true };
            }
            // 强制确保 result 可序列化（深拷贝走 JSON）
            return { ...obj, result: json !== undefined ? JSON.parse(json) : obj.result };
        } catch (_) {
            return { ...obj, result: String(obj.result), _serializationError: true };
        }
    }

    /**
     * 顶层入口：从 manifest 调用
     * @param {object} req { code, args, target, name?, _registry? }
     */
    async function execute(req) {
        const target = req?.target || CFG().sandbox?.defaultTarget || 'renderer';
        const allowed = (CFG().sandbox?.allowedTargets) || ['renderer', 'webview'];
        if (!allowed.includes(target)) {
            return { success: false, error: `target ${target} 不在允许列表 ${JSON.stringify(allowed)}` };
        }
        if (!req?.code || typeof req.code !== 'string') {
            return { success: false, error: 'script.execute: code (string) required' };
        }
        if (target === 'webview') return runWebviewCode(req.code, req.args);
        if (target === 'main') return runMainCode(req.code, req.args);
        return runRendererCode(req.code, req.args);
    }

    /** 把脚本投递到主进程 vm 沙箱执行（白名单 require：pptxgenjs/exceljs/...） */
    async function runMainCode(code, args) {
        const api = global.electronAPI?.skills;
        if (!api?.runMainScript) return { success: false, error: 'main 沙箱 IPC 未挂载（electronAPI.skills.runMainScript）' };
        try {
            return await api.runMainScript({ code, args });
        } catch (e) {
            return { success: false, error: e?.message || String(e) };
        }
    }

    const ScriptRuntime = { execute, runRendererCode, runWebviewCode };

    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        global.AgentV2.ScriptRuntime = ScriptRuntime;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = ScriptRuntime;
})(typeof window !== 'undefined' ? window : globalThis);
