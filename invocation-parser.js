/**
 * AgentV2 — InvocationParser
 *
 * 职责：解析 LLM 输出，提取调用块（fence-based + 可选 tool_call JSON）
 *
 * 文件结构：
 *   §1 配置常量（fence 正则、JSON 修复表）
 *   §2 主入口 parse()
 *   §3 各类解析函数
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 常量
     * ════════════════════════════════════════════════════════════ */
    const FENCE_REGEX = /```([\w:-]+)\s*\n([\s\S]*?)```/g;
    // 支持 namespace 形式：skill:create / mcp:filesystem.read

    /* ════════════════════════════════════════════════════════════
     *  §2 主入口
     * ════════════════════════════════════════════════════════════ */
    class InvocationParser {
        /**
         * @param {V2Registry} registry
         */
        constructor(registry) { this.registry = registry; }

        /**
         * @param {string} text - LLM 完整回复
         * @returns {Array<{manifestId, fence, args, raw, parseError?}>}
         */
        parse(text) { return _parse(this, text); }

        /**
         * 统一不同来源为 invocation 数组。
         * @param {object} input
         * @param {string} [input.text] LLM 文本（含 fence）
         * @param {Array}  [input.toolCalls] OpenAI 风格 tool_calls
         * @returns {Array<{manifestId, fence, args, raw, parseError?, source}>}
         */
        normalize(input) {
            const out = [];
            if (input?.text) {
                for (const inv of _parse(this, input.text)) out.push({ ...inv, source: 'fence' });
            }
            if (Array.isArray(input?.toolCalls)) {
                for (const tc of input.toolCalls) {
                    const name = tc?.function?.name || tc?.name;
                    const rawArgs = tc?.function?.arguments ?? tc?.arguments;
                    if (!name) continue;
                    const id = this.registry.idByFence(name) || (this.registry.get(name) ? name : null);
                    if (!id) continue;
                    let args = rawArgs;
                    let parseError = null;
                    if (typeof rawArgs === 'string') {
                        try { args = JSON.parse(rawArgs); }
                        catch (e) { args = _repairJSON(rawArgs); if (!args) parseError = String(e.message || e); }
                    }
                    out.push({ manifestId: id, fence: name, args: args || {}, raw: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {}), parseError, source: 'tool_call' });
                }
            }
            return out;
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 实现
     * ════════════════════════════════════════════════════════════ */
    function _parse(self, text) {
        if (!text || typeof text !== 'string') return [];
        const out = [];
        FENCE_REGEX.lastIndex = 0;
        let m;
        while ((m = FENCE_REGEX.exec(text)) !== null) {
            let fence = m[1].trim();
            const content = m[2].trim();

            // 支持 namespace 前缀 skill:create / agent:create
            if (fence.startsWith('skill:') || fence.startsWith('agent:')) {
                fence = fence.split(':')[1];
            }

            let id = self.registry.idByFence(fence);

            // ── 启发式：```json 包装的 V2 调用兼容 ──
            // 模型常误用 ```json 包装 create/edit 等动作。如果 fence 是 json/jsonc/javascript
            // 且内容明显是某个 V2 manifest 的 args（含已知 type/mode 字段），自动派发。
            if (!id && /^(json|jsonc|javascript|js)$/i.test(fence)) {
                const guessed = _guessV2Manifest(content, self.registry);
                if (guessed) {
                    id = guessed;
                    fence = guessed; // 转写为对应 fence
                }
            }

            if (!id) continue; // 不是 V2 fence，跳过

            let args = null;
            let parseError = null;
            const trimmed = (content || '').trim();
            if (!trimmed) {
                args = {}; // 空块视为无参数
            } else {
                // 1) 直接 JSON.parse（最常见：单对象 / 数组）
                let direct = null;
                try { direct = JSON.parse(trimmed); } catch (_) { /* try next */ }
                if (direct !== null && direct !== undefined) {
                    args = direct;
                } else {
                    // 2) 多 JSON 对象（fence 内连写多个 {} ，无逗号无外层数组）
                    const multi = _parseMultiObjects(trimmed);
                    if (multi && multi.length >= 2) {
                        args = multi;
                    } else if (multi && multi.length === 1) {
                        args = multi[0];
                    } else {
                        // 3) JSON 修复（尾随逗号 / 单引号 / 注释 / 宽松对象）
                        const repaired = _repairJSON(trimmed);
                        if (repaired) args = repaired;
                        else parseError = 'unable to parse fence content as JSON';
                    }
                }
            }
            out.push({ manifestId: id, fence, args, raw: content, parseError });
        }
        return out;
    }

    /** 启发式：根据 JSON 内容猜测对应的 V2 manifest id */
    function _guessV2Manifest(content, registry) {
        let obj;
        try { obj = JSON.parse(content); }
        catch { obj = _repairJSON(content); }
        if (!obj || typeof obj !== 'object') return null;

        // create：含已知文件类型（含别名）
        const createTypes = ['presentation', 'ppt', 'pptx', 'spreadsheet', 'xlsx', 'excel',
            'notebook', 'ipynb', 'webpage', 'html', 'document', 'doc', 'docx', 'hdoc',
            'markdown', 'md', 'code', 'project'];
        if (typeof obj.type === 'string' && createTypes.includes(obj.type.toLowerCase())) {
            return registry.get('create') ? 'create' : null;
        }
        // edit：含 type=read|insert|replace|find-replace|set-content|delete + 无 createTypes
        const editTypes = ['read', 'insert', 'replace', 'find-replace', 'set-content', 'delete', 'get-state'];
        if (typeof obj.type === 'string' && editTypes.includes(obj.type.toLowerCase())) {
            return registry.get('edit') ? 'edit' : null;
        }
        // file：type=read|write|list|tree|grep|search|mkdir|stat（与 edit 重叠的 read 让 edit 优先）
        const fileTypes = ['write', 'list', 'tree', 'grep', 'mkdir'];
        if (typeof obj.type === 'string' && fileTypes.includes(obj.type.toLowerCase())) {
            return registry.get('file') ? 'file' : null;
        }
        // read：mode=file|folder|page|tab|abstract，或 file-read/page-read/tab-read 等语法糖残留
        const readModes = ['file', 'folder', 'page', 'tab', 'abstract'];
        if (typeof obj.mode === 'string' && readModes.includes(obj.mode.toLowerCase())) {
            return registry.get('read') ? 'read' : null;
        }
        // sh：含 cmd / command
        if ((obj.cmd || obj.command) && typeof (obj.cmd || obj.command) === 'string') {
            return registry.get('sh') ? 'sh' : null;
        }
        // search：含 mode + queries[]
        if ((obj.mode || obj.queries) && (Array.isArray(obj.queries) || obj.query)) {
            return registry.get('search') ? 'search' : null;
        }
        return null;
    }

    /**
     * 扫描一段文本，提取多个顶层 JSON 对象/数组。
     * 用于 fence 内 AI 写入多条命令（无外层数组、无逗号分隔）的场景。
     * 返回数组：每项为成功解析的对象；若无法识别返回 null。
     */
    function _parseMultiObjects(text) {
        const t = String(text || '').trim();
        if (!t) return null;
        const items = [];
        let depth = 0;
        let start = -1;
        let inStr = false;
        let esc = false;
        let strCh = '"';
        for (let i = 0; i < t.length; i++) {
            const c = t[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === strCh) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
            if (c === '{' || c === '[') {
                if (depth === 0) start = i;
                depth++;
            } else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0 && start >= 0) {
                    const chunk = t.slice(start, i + 1);
                    let parsed;
                    try { parsed = JSON.parse(chunk); }
                    catch { try { parsed = _repairJSON(chunk); } catch { parsed = null; } }
                    if (parsed) items.push(parsed);
                    else return null;
                    start = -1;
                }
            }
        }
        if (depth !== 0) return null;
        return items.length ? items : null;
    }

    /** 简单 JSON 修复：去掉尾随逗号、单引号转双引号、注释去除 */
    function _repairJSON(text) {
        if (!text) return null;
        let t = text;
        // 去除 // 单行注释、/* */ 注释
        t = t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        // 去除尾随逗号
        t = t.replace(/,(\s*[}\]])/g, '$1');
        try { return JSON.parse(t); } catch { /* ignore */ }
        // 单引号 → 双引号（粗略）
        t = t.replace(/'/g, '"');
        try { return JSON.parse(t); } catch { /* ignore */ }
        return _parseRelaxedObject(t);
    }

    function _parseRelaxedObject(text) {
        const src = String(text || '').trim();
        if (!src.startsWith('{') || !src.endsWith('}')) return null;
        const out = {};
        let i = 1;
        while (i < src.length - 1) {
            i = _skipWsAndComma(src, i);
            if (i >= src.length - 1 || src[i] === '}') break;
            const keyInfo = _readRelaxedKey(src, i);
            if (!keyInfo) return null;
            i = _skipWs(src, keyInfo.next);
            if (src[i] !== ':') return null;
            i = _skipWs(src, i + 1);
            const valueInfo = _readRelaxedValue(src, i);
            if (!valueInfo) return null;
            out[keyInfo.key] = valueInfo.value;
            i = _skipWs(src, valueInfo.next);
            if (src[i] === ',') i += 1;
        }
        return out;
    }

    function _skipWs(src, i) {
        let cursor = i;
        while (cursor < src.length && /\s/.test(src[cursor])) cursor += 1;
        return cursor;
    }

    function _skipWsAndComma(src, i) {
        let cursor = i;
        while (cursor < src.length && (/\s/.test(src[cursor]) || src[cursor] === ',')) cursor += 1;
        return cursor;
    }

    function _readRelaxedKey(src, i) {
        const ch = src[i];
        if (ch === '"' || ch === "'") {
            const q = _readQuoted(src, i);
            return q ? { key: q.value, next: q.next } : null;
        }
        const start = i;
        let cursor = i;
        while (cursor < src.length && /[\w$-]/.test(src[cursor])) cursor += 1;
        const key = src.slice(start, cursor).trim();
        return key ? { key, next: cursor } : null;
    }

    function _readRelaxedValue(src, i) {
        const ch = src[i];
        if (ch === '"' || ch === "'") return _readQuoted(src, i);
        if (ch === '{' || ch === '[') {
            const end = _findBalancedEnd(src, i, ch === '{' ? '{' : '[', ch === '{' ? '}' : ']');
            if (end < 0) return null;
            const raw = src.slice(i, end + 1);
            const value = _repairJSON(raw);
            return value == null ? null : { value, next: end + 1 };
        }
        const tokenEnd = _findBareValueEnd(src, i);
        const token = src.slice(i, tokenEnd).trim();
        if (!token) return null;
        if (/^-?\d+(?:\.\d+)?$/.test(token)) return { value: Number(token), next: tokenEnd };
        if (token === 'true') return { value: true, next: tokenEnd };
        if (token === 'false') return { value: false, next: tokenEnd };
        if (token === 'null') return { value: null, next: tokenEnd };
        return { value: token, next: tokenEnd };
    }

    function _readQuoted(src, i) {
        const quote = src[i];
        let cursor = i + 1;
        let value = '';
        while (cursor < src.length) {
            const ch = src[cursor];
            if (ch === '\\') {
                if (cursor + 1 < src.length) value += src[cursor + 1];
                cursor += 2;
                continue;
            }
            if (ch === quote) return { value, next: cursor + 1 };
            value += ch;
            cursor += 1;
        }
        return null;
    }

    function _findBalancedEnd(src, start, open, close) {
        let depth = 0;
        let quote = '';
        for (let i = start; i < src.length; i++) {
            const ch = src[i];
            if (quote) {
                if (ch === '\\') { i += 1; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === open) depth += 1;
            else if (ch === close) {
                depth -= 1;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function _findBareValueEnd(src, start) {
        let quote = '';
        let brace = 0;
        let bracket = 0;
        for (let i = start; i < src.length; i++) {
            const ch = src[i];
            if (quote) {
                if (ch === '\\') { i += 1; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '{') { brace += 1; continue; }
            if (ch === '}') {
                if (brace === 0 && bracket === 0) return i;
                brace = Math.max(0, brace - 1);
                continue;
            }
            if (ch === '[') { bracket += 1; continue; }
            if (ch === ']') { bracket = Math.max(0, bracket - 1); continue; }
            if (ch === ',' && brace === 0 && bracket === 0) {
                const next = _skipWs(src, i + 1);
                if (_looksLikeKey(src, next) || src[next] === '}') return i;
            }
        }
        return src.length;
    }

    function _looksLikeKey(src, i) {
        if (i >= src.length) return false;
        const ch = src[i];
        if (ch === '"' || ch === "'") {
            const q = _readQuoted(src, i);
            return !!q && src[_skipWs(src, q.next)] === ':';
        }
        if (!/[A-Za-z_$]/.test(ch)) return false;
        let cursor = i;
        while (cursor < src.length && /[\w$-]/.test(src[cursor])) cursor += 1;
        return src[_skipWs(src, cursor)] === ':';
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { InvocationParser };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
