/**
 * AgentV2 — NativeExecutor
 *
 * 不依赖 V1 SkillManager 的核心执行层，直接走 Electron IPC（window.electronAPI）
 * 让 V2 引擎自身就具备类 Claude Code / Copilot CLI 的能力
 *
 * 文件结构：
 *   §1 配置 / 平台探测
 *   §2 主入口 NativeExecutor
 *   §3 各 manifest 的 native 实现（file / sh / search / list-tree）
 *   §4 工具函数
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 配置
     * ════════════════════════════════════════════════════════════ */
    const HANDLERS = {
        // manifestId → async function(args, ctx) => result
        file: _execFile,
        sh: _execShell,
        search: _execSearch,
        create: _execCreate,
        edit: _execEdit,
        read: _execRead,
        browser: _execBrowser,
        memo: _execMemo,
        subagent: _execSubagent,
    };

    function _decodeHtmlEntities(text) {
        return String(text || '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'");
    }

    function _normalizeDocumentDisplayText(text) {
        const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
        if (!raw) return '';
        if (!/<\/?[a-z][^>]*>/i.test(raw)) {
            return raw.split('\n').map(s => s.trim()).filter(Boolean).join(' / ');
        }
        let normalized = raw;
        normalized = normalized.replace(/<br\s*\/?>/gi, '\n');
        normalized = normalized.replace(/<li\b[^>]*>/gi, '- ');
        normalized = normalized.replace(/<h1\b[^>]*>/gi, '# ');
        normalized = normalized.replace(/<h2\b[^>]*>/gi, '## ');
        normalized = normalized.replace(/<h3\b[^>]*>/gi, '### ');
        normalized = normalized.replace(/<h4\b[^>]*>/gi, '#### ');
        normalized = normalized.replace(/<h5\b[^>]*>/gi, '##### ');
        normalized = normalized.replace(/<h6\b[^>]*>/gi, '###### ');
        normalized = normalized.replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, '\n');
        normalized = normalized.replace(/<(p|div|section|article)\b[^>]*>/gi, '');
        normalized = normalized.replace(/<[^>]+>/g, '');
        normalized = _decodeHtmlEntities(normalized);
        normalized = normalized.split('\n').map(s => s.trim()).filter(Boolean).join(' / ');
        return normalized || raw;
    }

    function _formatDocumentParagraphLines(paragraphs, from, to) {
        return paragraphs.slice(from - 1, to).map((p, i) => `${from + i}: ${_normalizeDocumentDisplayText(p?.text || '')}`);
    }

    /* ════════════════════════════════════════════════════════════
     *  §2 主入口
     * ════════════════════════════════════════════════════════════ */
    class NativeExecutor {
        constructor({ electronAPI, openInTab } = {}) {
            // 允许测试注入；默认从 window 取
            this.api = electronAPI || (global.electronAPI) || null;
            this.openInTab = openInTab || null;
            this._workspaceRoot = null;
            // 子执行器
            const NS = (global.AgentV2 || {});
            this._createExec = NS.CreateExecutor ? new NS.CreateExecutor({ electronAPI: this.api, openInTab: this.openInTab }) : null;
            this._editAdapter = NS.LineEditAdapter ? new NS.LineEditAdapter({ electronAPI: this.api }) : null;
        }

        setWorkspaceRoot(p) { this._workspaceRoot = p; }
        getWorkspaceRoot() {
            return this._workspaceRoot
                || (global.workspacePanel?.getRoot?.())
                || '';
        }

        /**
         * 是否能 native 执行该 manifest
         * @param {string} manifestId
         * @returns {boolean}
         */
        canHandle(manifestId) { return !!HANDLERS[manifestId] && !!this.api; }

        /**
         * 执行
         * @returns {Promise<{success, ...}>}
         */
        async execute(manifestId, args) {
            const fn = HANDLERS[manifestId];
            if (!fn) return { success: false, error: `native: no handler for ${manifestId}` };
            if (!this.api) return { success: false, error: 'native: electronAPI not available' };

            // ── 统一化：允许 args 为数组 / 含 actions[]、steps[] / action='batch'|'multi' ──
            const list = _normalizeArgsList(args);
            try {
                if (list.length <= 1) {
                    return await fn(list[0] || {}, this);
                }
                // 多步：逐个执行并汇总
                const results = [];
                let okCount = 0;
                for (let i = 0; i < list.length; i++) {
                    const step = list[i] || {};
                    let r;
                    try { r = await fn(step, this); }
                    catch (e) { r = { success: false, error: e.message || String(e) }; }
                    const isOk = !!(r && r.success !== false);
                    if (isOk) okCount++;
                    results.push(_summarizeBatchStepResult(manifestId, step, r, i, isOk));
                    if (!isOk && step.stopOnError) break;
                }
                return {
                    success: okCount === results.length,
                    total: list.length,
                    ok: okCount,
                    results,
                    summary: `${manifestId} batch: ${okCount}/${results.length} ok`,
                    stepSummaries: results.map(_formatBatchStepSummary).join('\n'),
                };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }
    }

    /**
     * 将调用参数规范化为步骤数组。
     * 兼容形式：
     *   - 数组 → 原样
     *   - { actions:[...] } / { steps:[...] } → actions/steps
     *   - { action:'batch'|'multi', actions:[...] } → actions
     *   - 其它 → [args]
     */
    function _normalizeArgsList(args) {
        if (Array.isArray(args)) return args;
        if (args && typeof args === 'object') {
            if (Array.isArray(args.actions)) return args.actions;
            if (Array.isArray(args.steps)) return args.steps;
            const a = String(args.action || args.type || '').toLowerCase();
            if ((a === 'batch' || a === 'multi') && (Array.isArray(args.list))) return args.list;
        }
        return [args || {}];
    }

    function _summarizeBatchStepResult(manifestId, step, result, index, isOk) {
        const action = step.action || step.type || step.mode;
        const base = { index, action, success: isOk };
        if (!result || typeof result !== 'object') return Object.assign(base, { result });
        if (manifestId !== 'browser') return Object.assign(base, result);
        if (result.success === false) {
            return Object.assign(base, { error: result.error || 'browser step failed' });
        }

        const browserAction = String(result.action || action || '').toLowerCase();
        if (browserAction === 'getstructure' || browserAction === 'structure') {
            const nodes = Array.isArray(result.nodes) ? result.nodes : [];
            return Object.assign(base, {
                url: result.url,
                title: result.title,
                count: typeof result.count === 'number' ? result.count : nodes.length,
                sample: nodes.slice(0, 5).map(n => ({
                    tag: n.tag,
                    label: n.label,
                    q: n.q,
                    text: n.text,
                    id: n.id,
                    name: n.name,
                    role: n.role,
                    type: n.type,
                    selector: n.selector,
                })),
                summary: `getStructure returned ${typeof result.count === 'number' ? result.count : nodes.length} nodes`,
            });
        }

        if (browserAction === 'extract' || browserAction === 'gettext') {
            const content = typeof result.content === 'string' ? result.content : '';
            return Object.assign(base, {
                length: result.length,
                contentPreview: content.slice(0, 240),
                summary: `extract returned ${result.length || content.length || 0} chars`,
            });
        }

        const compact = {};
        const keep = ['action', 'selector', 'tag', 'value', 'selected', 'fallback', 'url', 'tabId', 'title', 'y', 'length', 'result'];
        for (const key of keep) {
            if (result[key] !== undefined) compact[key] = result[key];
        }
        if (!compact.summary) {
            compact.summary = browserAction ? `${browserAction} ok` : 'browser step ok';
        }
        return Object.assign(base, compact);
    }

    function _formatBatchStepSummary(step) {
        if (!step || typeof step !== 'object') return String(step || '');
        const prefix = `[${step.index}] ${step.action || 'step'}`;
        if (step.success === false) return `${prefix}: failed${step.error ? ' - ' + step.error : ''}`;
        if (step.summary) return `${prefix}: ${step.summary}`;
        if (step.selector) return `${prefix}: ok (${step.selector})`;
        return `${prefix}: ok`;
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 实现
     * ════════════════════════════════════════════════════════════ */

    // ── file ──────────────────────────────────────────────
    async function _execFile(args, ctx) {
        const f = ctx.api.files;
        const type = args.type || 'read';
        const path = _resolvePath(ctx, args.path);
        if (!path && type !== 'pickDir') return { success: false, error: 'file: path is required' };

        switch (type) {
            case 'read': {
                const r = await f.readFile(path, args.encoding || 'utf8');
                if (r && r.success === false) return { success: false, error: r.error || 'read failed', path };
                const content = typeof r === 'string' ? r : (r?.content ?? r?.data ?? '');
                return { success: true, path, content, lines: typeof content === 'string' ? content.split('\n').length : 0 };
            }
            case 'write': {
                const r = await f.writeFile(path, args.content || '', args.encoding || 'utf8');
                if (r && r.success === false) return r;
                return { success: true, path, message: 'wrote ' + (args.content || '').length + ' chars' };
            }
            case 'list': {
                const r = await f.readDir(path);
                const items = r?.items || r?.entries || (Array.isArray(r) ? r : []);
                const limited = items.slice(0, args.limit || 200);
                return { success: true, path, total: items.length, items: limited.map(_simplifyEntry) };
            }
            case 'tree': {
                return _treeWalk(ctx, path, Number(args.depth || 2), args.glob);
            }
            case 'grep': {
                const r = await f.grep(path, args.pattern || args.query || '', { glob: args.glob, maxResults: args.maxResults || 50 });
                return { success: true, path, pattern: args.pattern, ...r };
            }
            case 'search': {
                const r = await f.search(path, args.query || '', { glob: args.glob, maxResults: args.maxResults || 50 });
                return { success: true, path, query: args.query, ...r };
            }
            case 'mkdir': {
                const r = await f.mkdir(path);
                return r?.success === false ? r : { success: true, path, message: 'created' };
            }
            case 'delete': {
                const r = await f.delete(path);
                return r?.success === false ? r : { success: true, path, message: 'deleted' };
            }
            case 'stat': {
                const r = await f.stat(path);
                return { success: true, path, ...r };
            }
            default:
                return { success: false, error: `file: unknown type "${type}"` };
        }
    }

    // ── sh ─────────────────────────────────────────────────
    async function _execShell(args, ctx) {
        const cmd = args.cmd || args.command || '';
        if (!cmd) return { success: false, error: 'sh: cmd is required' };
        const cwd = args.cwd ? _resolvePath(ctx, args.cwd) : ctx.getWorkspaceRoot();
        const r = await ctx.api.ai.executeTerminal({ command: cmd, cwd, timeout: args.timeout || 30000 });
        // 各种返回形态兼容
        if (r && typeof r.success === 'boolean') return { ...r, cmd, cwd };
        return { success: !r?.error, ...r, cmd, cwd };
    }
    // ── create ────────────────────────────────────────────
    async function _execCreate(args, ctx) {
        if (!ctx._createExec) return { success: false, error: 'create: CreateExecutor not loaded' };
        return ctx._createExec.execute(args);
    }
    // ── edit（按行/anchor 抽象） ──────────────────────────
    async function _execEdit(args, ctx) {
        if (!ctx._editAdapter) return { success: false, error: 'edit: LineEditAdapter not loaded' };
        return ctx._editAdapter.execute(args);
    }
    // ── read（与 search 互补：已知路径/标签 → 内容/摘要） ─
    async function _execRead(args, ctx) {
        const mode = String(args.mode || 'abstract').toLowerCase();
        switch (mode) {
            case 'abstract': return _readAbstract(args, ctx);
            case 'file': return _readFileOrFolder(args, ctx);
            case 'folder': return _readFolder(args, ctx);
            case 'page': return _readPage(args, ctx);
            case 'tab': return _readTab(args, ctx);
            default: return { success: false, error: `read: unknown mode "${mode}"` };
        }
    }
    async function _readAbstract(args, ctx) {
        const target = args.target;
        const tm = global.tabManager;
        const out = { success: true, mode: 'abstract' };
        if (!target || target === 'workspace') {
            const root = ctx.getWorkspaceRoot();
            out.workspace = root ? { root, status: 'open' } : { status: 'none', hint: '当前没有工作区，file/folder 模式不可用，请改用 page/tab' };
            if (root && ctx.api.files.readDir) {
                try {
                    const r = await ctx.api.files.readDir(root);
                    const items = r?.items || r?.results || [];
                    out.workspace.entries = items.slice(0, args.limit || 30).map(e => ({ name: e.name, isDir: !!e.isDirectory }));
                    out.workspace.total = items.length;
                } catch (e) { out.workspace.error = e.message; }
            }
        }
        if (!target || target === 'tabs') {
            if (tm?.tabs) {
                out.tabs = tm.tabs.slice(0, args.limit || 20).map(t => ({ id: t.id, title: t.title, url: t.url, active: tm.getActiveTab?.()?.id === t.id }));
                out.activeTabId = tm.getActiveTab?.()?.id;
            } else {
                out.tabs = [];
            }
        }
        if (!target || target === 'page') {
            const t = tm?.getActiveTab?.();
            if (t && /^https?:/.test(t.url || '')) {
                out.page = { id: t.id, url: t.url, title: t.title };
                // 自动抽取浏览器结构 + 标记 browserStage2 → 下轮披露 browser fullSpec
                try {
                    const wv = document.getElementById('webview-' + t.id);
                    if (wv && typeof wv.executeJavaScript === 'function') {
                        const structRaw = await _runInWebview(wv, _BROWSER_SCRIPTS.getStructure(args.limit || 200));
                        if (structRaw && structRaw.success) {
                            try { out.page.browser = JSON.parse(structRaw.result); }
                            catch (_) { out.page.browser = { raw: structRaw.result }; }
                        }
                    }
                } catch (_) { /* ignore */ }
                try {
                    if (global.aiChatManager) {
                        global.aiChatManager._v2DiscoveredFlags = Object.assign(
                            {}, global.aiChatManager._v2DiscoveredFlags,
                            { browserStage2: 2 }
                        );
                    }
                } catch (_) { /* ignore */ }
                out.page.hint = '当前为网页：可直接用 ```browser``` 进行 click/fillField/selectOption/injectJS（详细命令将在下一轮披露）。';
            } else if (t) {
                out.page = { id: t.id, title: t.title, url: t.url, kind: 'non-web' };
            } else {
                out.page = null;
            }
        }
        return out;
    }
    async function _readFileOrFolder(args, ctx) {
        const path = _resolvePath(ctx, args.path);
        if (!path) return { success: false, error: 'read file: path required (or empty workspace)' };
        // 判断是文件还是文件夹
        let isDir = false;
        try {
            if (ctx.api.files.stat) {
                const st = await ctx.api.files.stat(path);
                isDir = !!(st?.isDirectory || st?.isDir);
            }
        } catch (_) { /* fall through, treat as file */ }
        if (isDir) return _readFolder({ ...args, path }, ctx);
        // .hdoc/.docx/.pptx/.xlsx 等结构化文档：禁止 raw 读取（会暴露二进制/HTML/JSON），强制走打开后的 viewer
        const lowerPath = String(path).toLowerCase();
        // pptx / xlsx：通过路径式 adapter 读取已打开的 viewer（未打开则自动打开 + 等待就绪）
        if (/\.(pptx|xlsx)$/.test(lowerPath)) {
            const ext = lowerPath.match(/\.(pptx|xlsx)$/)[1];
            const tm = global.tabManager;
            const norm = (s) => decodeURIComponent(String(s || '').toLowerCase()).replace(/\\/g, '/');
            const target = norm(lowerPath);
            const findTab = () => tm?.tabs?.find(t => norm(t.url || '').includes(target));
            let tab = findTab();
            if (!tab) {
                // 自动打开
                try {
                    const url = `resource://file/${path.replace(/\\/g, '/')}`;
                    if (tm?.openResource) tm.openResource(path);
                    else if (tm?.createTab) tm.createTab(url, { type: ext === 'pptx' ? 'presentation' : 'spreadsheet' });
                    else if (tm?.openFile) tm.openFile(path);
                } catch (_) { /* ignore */ }
                // 轮询等待 tab 出现 + viewer 就绪（最多 ~6s）
                const isReady = (t) => {
                    if (!t) return false;
                    const v = tm?._resourceViewers?.get(t.id);
                    if (!v) return false;
                    if (ext === 'pptx') return !!(v._deck && Array.isArray(v._deck.slides));
                    return !!(Array.isArray(v._sheets) && typeof v._activeSheet !== 'undefined');
                };
                for (let i = 0; i < 60; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    tab = findTab();
                    if (isReady(tab)) break;
                }
                if (!isReady(tab)) {
                    return { success: false, error: `read: 自动打开 ${ext.toUpperCase()} 文件 ${path} 后，viewer 在 6s 内未就绪`, hint: '请稍后重试 read 同一路径', kind: ext };
                }
            }
            const adapters = global.AgentV2;
            if (adapters?.PptAdapter && adapters?.XlsxAdapter) {
                const adapter = ext === 'pptx' ? new adapters.PptAdapter({}) : new adapters.XlsxAdapter({});
                try {
                    const res = await adapter.read({});
                    return { ...res, mode: 'file', kind: ext, path, autoOpened: true };
                } catch (e) { return { success: false, error: 'read ' + ext + ': ' + (e.message || e) }; }
            }
            return { success: false, error: 'PptAdapter/XlsxAdapter 不可用' };
        }
        if (/\.(hdoc|docx)$/.test(lowerPath)) {
            const tm = global.tabManager;
            const norm = (s) => decodeURIComponent(String(s || '').toLowerCase()).replace(/\\/g, '/');
            const target = norm(lowerPath);
            const findTab = () => tm?.tabs?.find(t => norm(t.url || '').includes(target));
            let tab = findTab();
            if (!tab) {
                try {
                    if (tm?.openResource) tm.openResource(path);
                    else if (tm?.createTab) tm.createTab(`resource://file/${path.replace(/\\/g, '/')}`, { type: 'document' });
                    else if (tm?.openFile) tm.openFile(path);
                } catch (_) { /* ignore */ }
                for (let i = 0; i < 60; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    tab = findTab();
                    if (tab) {
                        const viewer = _findCanvasViewerForTab(tm, tab.id);
                        if (viewer && typeof viewer.getParagraphs === 'function') break;
                    }
                }
            }
            if (tab) {
                const viewer = _findCanvasViewerForTab(tm, tab.id);
                if (viewer && typeof viewer.getParagraphs === 'function') {
                    const paragraphs = viewer.getParagraphs() || [];
                    const total = paragraphs.length;
                    const from = Math.max(1, args.from || 1);
                    const to = Math.min(total, args.to || Math.min(total, from + 199));
                    const lines = _formatDocumentParagraphLines(paragraphs, from, to);
                    return { success: true, mode: 'file', kind: 'document', path, totalParagraphs: total, from, to, content: lines.join('\n'), format: 'lines', note: '文档采用按段落抽象；疑似 HTML 段落会标准化成 canvas-editor 文本表示。编辑请用 ```edit``` find-replace（纯文本片段）或 replace from..to' };
                }
            }
            return { success: false, error: `read: ${path} 是结构化文档，自动打开后仍未就绪。请稍后重试`, hint: '稍后重试 read 同一路径' };
        }
        // 普通文件：按行读
        const r = await ctx.api.files.readFile(path, args.encoding || 'utf8');
        if (r && r.success === false) return { success: false, error: r.error || 'read failed', path };
        const content = typeof r === 'string' ? r : (r?.content ?? r?.data ?? '');
        const allLines = String(content).split('\n');
        const total = allLines.length;
        const from = Math.max(1, args.from || 1);
        const to = Math.min(total, args.to || Math.min(total, from + 199));
        const slice = allLines.slice(from - 1, to);
        return { success: true, mode: 'file', path, total, from, to, content: slice.map((l, i) => `${from + i}: ${l}`).join('\n') };
    }
    async function _readFolder(args, ctx) {
        const path = _resolvePath(ctx, args.path) || ctx.getWorkspaceRoot();
        if (!path) return { success: false, error: 'read folder: path required (or empty workspace)' };
        if (!ctx.api.files.readDir) return { success: false, error: 'read folder: api.files.readDir unavailable' };
        const r = await ctx.api.files.readDir(path);
        const items = r?.items || r?.results || [];
        const dirs = items.filter(e => e.isDirectory).map(e => e.name);
        const files = items.filter(e => !e.isDirectory).map(e => e.name);
        // 按后缀聚合，过多则截断
        const maxPerExt = args.maxPerExt || 8;
        const byExt = {};
        for (const f of files) {
            const ext = (f.match(/\.[^.]+$/) || ['(no-ext)'])[0].toLowerCase();
            (byExt[ext] = byExt[ext] || []).push(f);
        }
        const filesByExt = {};
        for (const ext of Object.keys(byExt)) {
            const list = byExt[ext];
            filesByExt[ext] = list.length > maxPerExt ? list.slice(0, maxPerExt).concat(`…(+${list.length - maxPerExt} more)`) : list;
        }
        return { success: true, mode: 'folder', path, dirs, filesByExt, totalFiles: files.length, totalDirs: dirs.length };
    }
    async function _readPage(args, ctx) {
        const tm = global.tabManager;
        const t = tm?.getActiveTab?.();
        const url = args.url || t?.url;
        // 优先：PPT / XLSX viewer (通过 editorSkill._findEditorTab 检测活动 tab 类型)
        try {
            const ed = global.editorSkill;
            if (ed && typeof ed._findEditorTab === 'function') {
                const info = ed._findEditorTab();
                if (info?.viewerType === 'ppt' || info?.viewerType === 'xlsx') {
                    const adapters = global.AgentV2;
                    if (adapters?.PptAdapter && adapters?.XlsxAdapter) {
                        const adapter = info.viewerType === 'ppt'
                            ? new adapters.PptAdapter({})
                            : new adapters.XlsxAdapter({});
                        const fromArg = args.from && /^(slide|sheet):/i.test(String(args.from)) ? args.from : undefined;
                        try {
                            const res = await adapter.read({ from: fromArg });
                            return { ...res, mode: 'page', kind: info.viewerType, tabId: t?.id, title: t?.title };
                        } catch (e) { return { success: false, error: 'read page (' + info.viewerType + '): ' + (e.message || e) }; }
                    }
                }
            }
        } catch (_) { /* fallthrough */ }
        // 网页 → BrowserSkill
        if (url && /^https?:/.test(url)) {
            const browser = global.browserSkill || global.skillManager?.getSkill?.('browser');
            if (browser && (browser.executeAction || browser.execute)) {
                const exec = browser.executeAction ? browser.executeAction.bind(browser) : browser.execute.bind(browser);
                try {
                    const r = await exec({ action: 'getPageContent', type: 'getPageContent', url });
                    return { success: true, mode: 'page', kind: 'web', url, ...r };
                } catch (e) { return { success: false, error: 'read page: ' + (e.message || e) }; }
            }
            return { success: true, mode: 'page', kind: 'web', url, title: t?.title, note: 'BrowserSkill 不可用' };
        }
        // 文档/编辑器 → 直接读 canvas-editor viewer（与 edit 同源），格式：1: 段文本
        if (t && (url || '').startsWith('aiview://')) {
            const viewer = _findCanvasViewerForTab(global.tabManager, t.id);
            if (viewer && typeof viewer.getParagraphs === 'function') {
                const paragraphs = viewer.getParagraphs() || [];
                const total = paragraphs.length;
                const from = Math.max(1, args.from || 1);
                const to = Math.min(total, args.to || Math.min(total, from + 199));
                const lines = _formatDocumentParagraphLines(paragraphs, from, to);
                return { success: true, mode: 'page', kind: 'document', tabId: t.id, title: t.title, totalParagraphs: total, from, to, content: lines.join('\n'), format: 'lines', note: '段格式 "行号: 文本"；疑似 HTML 段落已标准化为 canvas-editor 文本表示，系统会在批量 edit 前把数字行号内部锁成稳定段锚点' };
            }
            // 兜底：委派 EditorSkill
            const ed = global.editorSkill || global.skillManager?.getSkill?.('editor');
            if (ed?.executeAction || ed?.execute) {
                const exec = ed.executeAction ? ed.executeAction.bind(ed) : ed.execute.bind(ed);
                try {
                    const r = await exec({ type: 'read', lineStart: args.from || 1, lineEnd: args.to || 200 });
                    return { success: true, mode: 'page', kind: 'document', tabId: t.id, title: t.title, ...r };
                } catch (e) { return { success: false, error: 'read page (document): ' + (e.message || e) }; }
            }
        }
        // 资源文件标签
        if (t && (url || '').startsWith('resource://')) {
            return _readTab({ id: t.id, from: args.from, to: args.to }, ctx);
        }
        // 完全没活动标签
        if (!t) return { success: false, error: 'read page: 当前没有活动标签页', hint: '请先打开一个网页/文档/文件' };
        // 兜底：返回元数据
        return { success: true, mode: 'page', kind: 'meta-only', tabId: t.id, title: t.title, url: t.url, note: '当前标签不是网页或文档，仅返回元数据' };
    }
    async function _readTab(args, ctx) {
        const tm = global.tabManager;
        if (!tm) return { success: false, error: 'read tab: tabManager not available' };
        let t = null;
        if (args.id != null) t = tm.tabs?.find(x => String(x.id) === String(args.id));
        else if (args.title) {
            const lower = String(args.title).toLowerCase();
            t = tm.tabs?.find(x => (x.title || '').toLowerCase() === lower)
                || tm.tabs?.find(x => (x.title || '').toLowerCase().includes(lower));
        } else {
            t = tm.getActiveTab?.();
        }
        if (!t) return { success: false, error: 'read tab: not found' };
        // 网页 → page；编辑器 → 调 _getState；资源 → 读文件
        if (/^https?:/.test(t.url || '')) return _readPage({ url: t.url }, ctx);
        if ((t.url || '').startsWith('aiview://')) {
            const ed = global.editorSkill;
            const state = ed?._getState?.() || null;
            return { success: true, mode: 'tab', kind: 'editor', id: t.id, title: t.title, url: t.url, state };
        }
        if ((t.url || '').startsWith('resource://')) {
            const m = (t.url || '').match(/^resource:\/\/[^?#]+/);
            const path = m ? decodeURIComponent(m[0].replace(/^resource:\/\//, '')) : '';
            return _readFileOrFolder({ path, from: args.from, to: args.to }, ctx);
        }
        return { success: true, mode: 'tab', id: t.id, title: t.title, url: t.url };
    }
    // ── search（多关键词批量） ────────────────────────────
    async function _execSearch(args, ctx) {
        // 支持：
        //   { mode:"web", queries:["...","..."], engine?:"baidu|bing|google" }
        //   { mode:"workspace", queries:["..."], glob?:"**/*.js" }
        //   { mode:"grep", queries:["..."], path?:".", glob?:"..." }   (= grep 多关键词)
        // 默认模式：若 query 看起来不像代码关键词 → web；否则 workspace
        let mode = args.mode;
        const queries = Array.isArray(args.queries) ? args.queries : (args.query ? [args.query] : []);
        if (queries.length === 0) return { success: false, error: 'search: queries[] required' };
        if (!mode) {
            const looksLikeNL = queries.some(q => /[\u4e00-\u9fff\s?？]/.test(q || ''));
            mode = looksLikeNL ? 'web' : 'workspace';
        }

        if (mode === 'workspace' || mode === 'grep') {
            const path = _resolvePath(ctx, args.path) || ctx.getWorkspaceRoot();
            if (!path) {
                // 没工作区根 → 提示，并自动改走 web 兜底
                mode = 'web';
            } else {
                const all = [];
                for (const q of queries) {
                    const r = await ctx.api.files.grep(path, q, { glob: args.glob, maxResults: args.maxResultsPerQuery || 30 });
                    all.push({ query: q, matches: r?.matches || r?.results || [], count: (r?.matches || r?.results || []).length });
                }
                return { success: true, mode, path, results: all, totalQueries: queries.length };
            }
        }

        if (mode === 'files') {
            const root = _resolvePath(ctx, args.path) || ctx.getWorkspaceRoot();
            if (!root) return { success: false, error: 'search files: no workspace root' };
            if (!ctx.api.files.search) return { success: false, error: 'search files: api.files.search not available' };
            const all = [];
            for (const q of queries) {
                const r = await ctx.api.files.search(root, q, { glob: args.glob });
                all.push({ query: q, results: r?.results || [], count: (r?.results || []).length });
            }
            return { success: true, mode, path: root, results: all, totalQueries: queries.length };
        }

        if (mode === 'web') {
            // 委派给 V1 BrowserSkill（如可用）
            const browser = global.browserSkill || global.skillManager?.getSkill?.('browser');
            if (!browser || (!browser.executeAction && !browser.execute)) {
                return { success: false, error: 'search web: BrowserSkill not available' };
            }
            const exec = browser.executeAction ? browser.executeAction.bind(browser) : browser.execute.bind(browser);
            const engine = args.engine || 'auto'; // 默认走 BrowserSkill 智能路由
            const results = [];
            for (const q of queries) {
                const r = await exec({ action: 'searchWeb', type: 'searchWeb', query: q, params: { query: q, engine, maxResults: args.maxResults }, engine });
                results.push({ query: q, ...r });
            }
            return { success: true, mode, engine, results };
        }

        return { success: false, error: `search: unknown mode "${mode}"` };
    }

    /* ════════════════════════════════════════════════════════════
     *  §3.5 browser / memo / subagent 实现（高容错，所有参数可省）
     * ════════════════════════════════════════════════════════════ */

    function _getActiveWebview() {
        const tm = global.tabManager;
        const t = tm?.getActiveTab?.();
        if (!t) return { tab: null, webview: null };
        const wv = document.getElementById('webview-' + t.id);
        return { tab: t, webview: wv };
    }

    async function _runInWebview(wv, code) {
        if (!wv || typeof wv.executeJavaScript !== 'function') {
            return { success: false, error: 'no active webview' };
        }
        try {
            const r = await wv.executeJavaScript(code, false);
            return { success: true, result: r };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    function _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function _findWebviewByTabId(tabId, retries = 8, delayMs = 120) {
        for (let i = 0; i < retries; i++) {
            const wv = document.getElementById('webview-' + tabId);
            if (wv) return wv;
            await _delay(delayMs);
        }
        return null;
    }

    async function _waitForWebviewStable(wv, timeoutMs = 1500) {
        if (!wv || typeof wv.addEventListener !== 'function') return;
        if (typeof wv.isLoading === 'function' && !wv.isLoading()) {
            await _delay(180);
            return;
        }
        await new Promise(resolve => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                try { wv.removeEventListener('did-stop-loading', onStop); } catch (_) { }
                try { wv.removeEventListener('did-fail-load', onStop); } catch (_) { }
                resolve();
            };
            const onStop = () => done();
            const timer = setTimeout(done, timeoutMs);
            wv.addEventListener('did-stop-loading', () => {
                clearTimeout(timer);
                onStop();
            }, { once: true });
            wv.addEventListener('did-fail-load', () => {
                clearTimeout(timer);
                onStop();
            }, { once: true });
        });
        await _delay(180);
    }

    function _pickBrowserItems(list, limit) {
        return (Array.isArray(list) ? list : []).slice(0, limit).map(item => ({
            idx: item.idx,
            id: item.id,
            role: item.role,
            tag: item.tag,
            text: item.text,
            label: item.label,
            title: item.title,
            shortcut: item.shortcut,
            className: item.className,
            q: item.q,
            href: item.href,
            selector: item.selector,
        }));
    }

    function _storeBrowserSnapshot(tab, snapshot) {
        if (!snapshot || !global.aiChatManager) return;
        const safe = {
            url: snapshot.url || '',
            title: snapshot.title || '',
            count: snapshot.count || 0,
            buttons: _pickBrowserItems(snapshot.buttons, 12),
            links: _pickBrowserItems(snapshot.links, 12),
            texts: _pickBrowserItems(snapshot.texts, 20),
            tabId: tab?.id != null ? tab.id : (snapshot.tabId != null ? snapshot.tabId : null),
            capturedAt: Date.now(),
        };
        global.aiChatManager._v2BrowserSnapshot = safe;
    }

    async function _captureBrowserSnapshot(wv, limit) {
        if (!wv) return null;
        await _waitForWebviewStable(wv);
        const r = await _runInWebview(wv, _BROWSER_SCRIPTS.getStructure(limit || 120));
        if (!r.success) return null;
        try {
            const parsed = JSON.parse(r.result);
            return {
                url: parsed.url,
                title: parsed.title,
                count: parsed.count,
                buttons: _pickBrowserItems(parsed.buttons, 12),
                links: _pickBrowserItems(parsed.links, 12),
                texts: _pickBrowserItems(parsed.texts, 20),
            };
        } catch (_) {
            return null;
        }
    }

    // 用于在页面里抽取结构 / 操作的脚本（注入字符串）
    const _BROWSER_SCRIPTS = {
        getStructure: (limit) => `(function(){
            const limit = ${Number(limit) || 200};
            function sel(el){
                if (!el || el.nodeType !== 1) return '';
                if (el.id) return '#' + CSS.escape(el.id);
                const parts = [];
                let cur = el;
                while (cur && cur.nodeType === 1 && parts.length < 5) {
                    let s = cur.tagName.toLowerCase();
                    if (cur.classList && cur.classList.length) s += '.' + Array.from(cur.classList).slice(0,2).map(c=>CSS.escape(c)).join('.');
                    const par = cur.parentElement;
                    if (par) {
                        const sib = Array.from(par.children).filter(x => x.tagName === cur.tagName);
                        if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
                    }
                    parts.unshift(s); cur = cur.parentElement;
                }
                return parts.join('>');
            }
            function visible(el){
                if (!el || el.nodeType !== 1) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }
            function firstText(el){
                const t = String(el && (el.innerText || el.textContent || el.value || el.placeholder || '') || '').trim();
                return t.replace(/\\s+/g, ' ').slice(0, 80);
            }
            function findLabel(el){
                if (!el) return '';
                if (el.id) {
                    const byFor = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                    const txt = firstText(byFor);
                    if (txt) return txt;
                }
                const wrapped = el.closest && el.closest('label');
                const wrappedText = firstText(wrapped);
                if (wrappedText) return wrappedText;
                const optionWrap = el.closest && el.closest('.ui-radio,.ui-checkbox,[role="radio"],[role="checkbox"],[class*="radio"],[class*="checkbox"]');
                const optionText = firstText(optionWrap);
                if (optionText) return optionText;
                const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
                if (aria) return String(aria).trim().slice(0, 80);
                return firstText(el);
            }
            function titleOf(el){
                const title = el && el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('aria-description'));
                return String(title || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
            }
            function shortcutOf(text){
                const t = String(text || '');
                const m = t.match(/[（(]([A-Za-z0-9+]+)[）)]/);
                return m ? String(m[1] || '').trim().toUpperCase() : '';
            }
            function questionOf(el){
                const field = el.closest && el.closest('.field,.ui-field-contain,fieldset,[class*="question"]');
                if (!field) return '';
                const head = field.querySelector('.field-label,.topichtml,.control-label,legend,.question-title,.qtitle,h1,h2,h3,h4');
                const raw = String(head ? (head.innerText || head.textContent || '') : (field.innerText || '')).trim();
                const lines = raw.split(/\\n+/)
                    .map(s => s.replace(/[\\*\\s]+/g, ' ').trim())
                    .filter(Boolean)
                    .filter(s => !/^\\*+$/.test(s) && !/^\\d+[\\.、:：\\s]*$/.test(s));
                if (!lines.length) return '';
                return lines[0].replace(/^\\d+\\s*[\\.、:：]\\s*/, '').trim().slice(0, 80);
            }
            function summarize(item){
                return {
                    idx: item.idx,
                    id: item.id,
                    role: item.role,
                    tag: item.tag,
                    text: item.text,
                    label: item.label,
                    title: item.title || '',
                    shortcut: item.shortcut || '',
                    className: item.className || '',
                    q: item.q,
                    href: item.href || '',
                    selector: item.selector,
                };
            }
            const seen = new WeakSet();
            const out = [];
            let idx = 0;
            function push(role, el, extra){
                if (!el || seen.has(el) || !visible(el) || out.length >= limit) return;
                seen.add(el);
                const item = {
                    idx: ++idx,
                    role,
                    tag: el.tagName.toLowerCase(),
                    label: findLabel(el),
                    q: questionOf(el),
                    selector: sel(el),
                    text: firstText(el),
                    id: el.id || '',
                    name: el.getAttribute && el.getAttribute('name') || '',
                    type: el.getAttribute && el.getAttribute('type') || '',
                    title: titleOf(el),
                    shortcut: shortcutOf(titleOf(el)),
                    className: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : '',
                    value: typeof el.value === 'string' ? String(el.value).slice(0, 40) : '',
                    __el: el,
                };
                if (extra) Object.assign(item, extra);
                out.push(item);
            }

            document.querySelectorAll('input,textarea,select').forEach(el => {
                if (el.disabled) return;
                const inputType = String(el.type || '').toLowerCase();
                if (inputType === 'hidden') return;
                let role = 'input';
                if (inputType === 'radio') role = 'radio';
                else if (inputType === 'checkbox') role = 'checkbox';
                else if (el.tagName === 'TEXTAREA') role = 'textarea';
                else if (el.tagName === 'SELECT') role = 'select';
                push(role, el);
            });

            document.querySelectorAll('a.jqradio,a.jqcheck,[role="radio"],[role="checkbox"]').forEach(el => {
                const role = (el.classList.contains('jqcheck') || el.getAttribute('role') === 'checkbox') ? 'checkbox' : 'radio';
                push(role, el);
            });

            document.querySelectorAll('button,[role="button"],a').forEach(el => {
                if (el.matches && el.matches('a.jqradio,a.jqcheck,[role="radio"],[role="checkbox"]')) return;
                const txt = findLabel(el);
                if (!txt) return;
                const role = (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') ? 'button' : 'link';
                push(role, el, { href: el.href || '' });
            });

            document.querySelectorAll('[title],[aria-label],[tabindex],.video-toolbar-left-item,.toolbar-left-item-wrap,[class*="btn"],[class*="button"],[class*="icon-button"],[class*="tool-btn"]').forEach(el => {
                if (!el || !el.tagName) return;
                if (el.matches && el.matches('input,textarea,select,a,button,[role="button"],[role="link"],[role="radio"],[role="checkbox"]')) return;
                const label = findLabel(el) || titleOf(el);
                if (!label) return;
                push('button', el, { href: el.href || '' });
            });

            try {
                window.__hpV2Nodes = out.map(item => item.__el);
                window.__hpV2Catalog = out.map(item => Object.assign({}, summarize(item), { __el: item.__el }));
            } catch (_) { }

            const clean = out.map(item => {
                const clone = Object.assign({}, item);
                delete clone.__el;
                return clone;
            });

            const buttons = clean
                .filter(item => item.role === 'button' || item.role === 'radio' || item.role === 'checkbox')
                .map(summarize)
                .slice(0, limit);
            const links = clean
                .filter(item => item.role === 'link')
                .map(summarize)
                .slice(0, limit);

            const textSeen = new Set();
            const texts = [];
            document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,dt,dd,summary,article,section,main,aside,div,span,label').forEach(el => {
                if (texts.length >= limit) return;
                if (!visible(el)) return;
                if (el.matches('a,button,input,textarea,select,[role="button"],[role="link"],[role="radio"],[role="checkbox"]')) return;
                if (el.querySelector && el.querySelector('a,button,input,textarea,select,[role="button"],[role="link"]')) return;
                const text = firstText(el);
                if (!text || text.length < 2) return;
                const key = text.toLowerCase();
                if (textSeen.has(key)) return;
                textSeen.add(key);
                texts.push({
                    idx: null,
                    id: el.id || '',
                    role: 'text',
                    tag: el.tagName.toLowerCase(),
                    text,
                    label: '',
                    q: '',
                    href: '',
                    selector: sel(el),
                });
            });

            return JSON.stringify({ url: location.href, title: document.title, count: clean.length, nodes: clean, buttons, links, texts });
        })();`,

        fillField: (selector, value, idx) => `(function(){
            const sel = ${JSON.stringify(selector || '')}; const v = ${JSON.stringify(value == null ? '' : String(value))}; const idx = ${Number(idx) || 0};
            let el = null;
            if (idx > 0 && Array.isArray(window.__hpV2Nodes)) el = window.__hpV2Nodes[idx - 1] || null;
            if (!el) el = sel ? document.querySelector(sel) : document.activeElement;
            if (!el) return JSON.stringify({success:false,error:'element not found'});
            try {
                const tag = el.tagName;
                const role = (el.getAttribute && el.getAttribute('role')) || '';
                const inputType = (el.type || '').toLowerCase();
                // \u53ef\u70b9\u51fb\u578b\u63a7\u4ef6\uff08\u5355\u9009/\u591a\u9009/\u6309\u94ae/\u94fe\u63a5/\u81ea\u5b9a\u4e49\u3010role\u3011\uff09\u2192 \u9000\u5316\u4e3a click
                const clickyTags = ['A','BUTTON','LABEL'];
                const clickyTypes = ['radio','checkbox','button','submit','reset'];
                const clickyRoles = ['button','link','radio','checkbox','tab','option','menuitem'];
                const isClicky = clickyTags.includes(tag) || clickyTypes.includes(inputType) || clickyRoles.includes(role);
                if (tag === 'INPUT' && !clickyTypes.includes(inputType)) {
                    const proto = HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                    setter.call(el, v);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (tag === 'TEXTAREA') {
                    const proto = HTMLTextAreaElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                    setter.call(el, v);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (tag === 'SELECT') {
                    let matched = false;
                    for (const opt of el.options) {
                        if (opt.value === v || opt.label === v || opt.text === v) { el.value = opt.value; matched = true; break; }
                    }
                    if (!matched) return JSON.stringify({success:false,error:'select option not found'});
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return JSON.stringify({success:true,selector:sel,fallback:'select',value:el.value});
                } else if (el.isContentEditable) {
                    el.focus(); document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, v);
                } else if (isClicky) {
                    // \u9000\u5316\u4e3a click\uff08\u9009\u9879\u7c7b/\u6309\u94ae\u7c7b\uff09
                    el.click();
                    return JSON.stringify({success:true,selector:sel,idx:idx,fallback:'click',tag:tag.toLowerCase()});
                } else { return JSON.stringify({success:false,error:'not a fillable field; tag='+tag}); }
                return JSON.stringify({success:true,selector:sel,idx:idx,value:v});
            } catch (e) { return JSON.stringify({success:false,error:e.message}); }
        })();`,

        selectOption: (selector, value, idx) => `(function(){
            const sel = ${JSON.stringify(selector || '')}; const v = ${JSON.stringify(String(value == null ? '' : value))}; const idx = ${Number(idx) || 0};
            let el = null;
            if (idx > 0 && Array.isArray(window.__hpV2Nodes)) el = window.__hpV2Nodes[idx - 1] || null;
            if (!el) el = document.querySelector(sel);
            if (!el) return JSON.stringify({success:false,error:'element not found'});
            if (el.tagName !== 'SELECT') return JSON.stringify({success:false,error:'not a select'});
            let matched = false;
            for (const opt of el.options) {
                if (opt.value === v || opt.label === v || opt.text === v) { el.value = opt.value; matched = true; break; }
            }
            if (!matched) return JSON.stringify({success:false,error:'option not found'});
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({success:true,selector:sel,idx:idx,selected:el.value});
        })();`,

        click: (selector, idx, text, id, href, label, q, title, shortcut) => `(function(){
            const sel = ${JSON.stringify(selector || '')};
            const idx = ${Number(idx) || 0};
            const queryText = ${JSON.stringify(text || '')};
            const queryId = ${JSON.stringify(id || '')};
            const queryHref = ${JSON.stringify(href || '')};
            const queryLabel = ${JSON.stringify(label || '')};
            const queryQ = ${JSON.stringify(q || '')};
            const queryTitle = ${JSON.stringify(title || '')};
            const queryShortcut = ${JSON.stringify(shortcut || '')};
            function norm(v){ return String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
            function firstText(el){ return String(el && (el.innerText || el.textContent || el.value || el.placeholder || '') || '').replace(/\\s+/g, ' ').trim().slice(0, 120); }
            function titleOf(el){ return String(el && el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('aria-description')) || '').replace(/\\s+/g, ' ').trim().slice(0, 120); }
            function shortcutOf(text){ const m = String(text || '').match(/[（(]([A-Za-z0-9+]+)[）)]/); return m ? String(m[1] || '').trim().toLowerCase() : ''; }
            function findLabel(el){
                if (!el) return '';
                if (el.id) {
                    const byFor = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                    const txt = firstText(byFor);
                    if (txt) return txt;
                }
                const wrapped = el.closest && el.closest('label');
                const wrappedText = firstText(wrapped);
                if (wrappedText) return wrappedText;
                const optionWrap = el.closest && el.closest('.ui-radio,.ui-checkbox,[role="radio"],[role="checkbox"],[class*="radio"],[class*="checkbox"]');
                const optionText = firstText(optionWrap);
                if (optionText) return optionText;
                return firstText(el);
            }
            function questionOf(el){
                const field = el.closest && el.closest('.field,.ui-field-contain,fieldset,[class*="question"]');
                if (!field) return '';
                const head = field.querySelector('.field-label,.topichtml,.control-label,legend,.question-title,.qtitle,h1,h2,h3,h4');
                const raw = String(head ? (head.innerText || head.textContent || '') : (field.innerText || '')).trim();
                const lines = raw.split(/\\n+/)
                    .map(s => s.replace(/[\\*\\s]+/g, ' ').trim())
                    .filter(Boolean)
                    .filter(s => !/^\\*+$/.test(s) && !/^\\d+[\\.、:：\\s]*$/.test(s));
                if (!lines.length) return '';
                return lines[0].replace(/^\\d+\\s*[\\.、:：]\\s*/, '').trim().slice(0, 80);
            }
            function candidateMeta(el){
                const catalog = Array.isArray(window.__hpV2Catalog) ? window.__hpV2Catalog : [];
                const hit = catalog.find(item => item && item.__el === el);
                return {
                    idx: hit && hit.idx || 0,
                    selector: hit && hit.selector || (el.id ? '#' + CSS.escape(el.id) : ''),
                    id: el.id || '',
                    text: firstText(el),
                    label: findLabel(el),
                    title: titleOf(el),
                    shortcut: shortcutOf(titleOf(el)),
                    className: el.className && typeof el.className === 'string' ? el.className : '',
                    q: questionOf(el),
                    href: el.href || el.getAttribute && el.getAttribute('href') || '',
                    role: el.getAttribute && el.getAttribute('role') || '',
                };
            }
            function score(meta){
                let points = 0;
                const textNorm = norm(meta.text);
                const labelNorm = norm(meta.label);
                const titleNorm = norm(meta.title);
                const shortcutNorm = norm(meta.shortcut);
                const qNorm = norm(meta.q);
                const idNorm = norm(meta.id);
                const hrefNorm = norm(meta.href);
                if (queryId) {
                    const qv = norm(queryId);
                    if (idNorm === qv) points += 140;
                    else if (idNorm.includes(qv)) points += 80;
                }
                if (queryHref) {
                    const qv = norm(queryHref);
                    if (hrefNorm === qv) points += 120;
                    else if (hrefNorm.includes(qv)) points += 70;
                }
                if (queryLabel) {
                    const qv = norm(queryLabel);
                    if (labelNorm === qv) points += 110;
                    else if (labelNorm.includes(qv) || qv.includes(labelNorm) || titleNorm.includes(qv)) points += 70;
                }
                if (queryText) {
                    const qv = norm(queryText);
                    if (textNorm === qv) points += 100;
                    else if (textNorm.includes(qv) || labelNorm.includes(qv) || titleNorm.includes(qv)) points += 65;
                }
                if (queryTitle) {
                    const qv = norm(queryTitle);
                    if (titleNorm === qv) points += 125;
                    else if (titleNorm.includes(qv) || qv.includes(titleNorm)) points += 80;
                }
                if (queryShortcut) {
                    const qv = norm(queryShortcut);
                    if (shortcutNorm === qv) points += 130;
                    else if (titleNorm.includes(qv)) points += 60;
                }
                if (queryQ) {
                    const qv = norm(queryQ);
                    if (qNorm === qv) points += 90;
                    else if (qNorm.includes(qv)) points += 55;
                }
                return points;
            }
            let el = null;
            let meta = null;
            if (idx > 0 && Array.isArray(window.__hpV2Nodes)) el = window.__hpV2Nodes[idx - 1] || null;
            if (!el && sel) el = document.querySelector(sel);
            if (!el && queryId) {
                el = document.getElementById(queryId) || document.querySelector('#' + CSS.escape(queryId));
            }
            if (!el) {
                const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,label,[role="button"],[role="link"],[role="radio"],[role="checkbox"],a.jqradio,a.jqcheck'));
                let bestScore = 0;
                let bestEl = null;
                let bestMeta = null;
                for (const candidate of candidates) {
                    const current = candidateMeta(candidate);
                    const currentScore = score(current);
                    if (currentScore > bestScore) {
                        bestScore = currentScore;
                        bestEl = candidate;
                        bestMeta = current;
                    }
                }
                if (bestScore > 0) {
                    el = bestEl;
                    meta = bestMeta;
                }
            }
            if (!el) return JSON.stringify({success:false,error:'element not found',query:{selector:sel,idx:idx,text:queryText,id:queryId,href:queryHref,label:queryLabel,title:queryTitle,shortcut:queryShortcut,q:queryQ}});
            meta = meta || candidateMeta(el);
            el.click();
            return JSON.stringify({success:true,selector:sel || meta.selector || '',idx:meta.idx || idx,id:meta.id || '',text:meta.text || '',label:meta.label || '',title:meta.title || '',shortcut:meta.shortcut || '',className:meta.className || '',q:meta.q || '',href:meta.href || '',tag:el.tagName.toLowerCase()});
        })();`,

        pressKey: (key, selector, idx, text, id) => `(function(){
            const key = ${JSON.stringify(String(key || 'Enter'))};
            const sel = ${JSON.stringify(selector || '')};
            const idx = ${Number(idx) || 0};
            const queryText = ${JSON.stringify(text || '')};
            const queryId = ${JSON.stringify(id || '')};
            function norm(v){ return String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
            function firstText(el){ return String(el && (el.innerText || el.textContent || el.value || el.placeholder || '') || '').replace(/\\s+/g, ' ').trim().slice(0, 120); }
            function keyMeta(name){
                const parts = String(name || '').split('+').map(s => s.trim()).filter(Boolean);
                const main = parts.length ? parts[parts.length - 1] : String(name || 'Enter');
                const modifiers = new Set(parts.slice(0, -1).map(s => s.toLowerCase()));
                const lower = String(main || '').toLowerCase();
                const aliases = { enter:'Enter', return:'Enter', esc:'Escape', escape:'Escape', tab:'Tab', space:' ', spacebar:' ', up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight', delete:'Delete', backspace:'Backspace' };
                const resolved = aliases[lower] || main;
                const codeMap = { Enter:'Enter', Escape:'Escape', Tab:'Tab', ' ':'Space', ArrowUp:'ArrowUp', ArrowDown:'ArrowDown', ArrowLeft:'ArrowLeft', ArrowRight:'ArrowRight', Delete:'Delete', Backspace:'Backspace' };
                const keyCodeMap = { Enter:13, Escape:27, Tab:9, ' ':32, ArrowUp:38, ArrowDown:40, ArrowLeft:37, ArrowRight:39, Delete:46, Backspace:8 };
                const code = codeMap[resolved] || (/^[a-z]$/i.test(resolved) ? 'Key' + resolved.toUpperCase() : resolved);
                const keyCode = keyCodeMap[resolved] || (/^[a-z]$/i.test(resolved) ? resolved.toUpperCase().charCodeAt(0) : 0);
                return {
                    key: resolved,
                    code,
                    keyCode,
                    ctrlKey: modifiers.has('ctrl') || modifiers.has('control'),
                    shiftKey: modifiers.has('shift'),
                    altKey: modifiers.has('alt'),
                    metaKey: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
                };
            }
            let el = null;
            if (idx > 0 && Array.isArray(window.__hpV2Nodes)) el = window.__hpV2Nodes[idx - 1] || null;
            if (!el && sel) el = document.querySelector(sel);
            if (!el && queryId) el = document.getElementById(queryId) || document.querySelector('#' + CSS.escape(queryId));
            if (!el && queryText) {
                const query = norm(queryText);
                const candidates = Array.from(document.querySelectorAll('input,textarea,select,button,a,[role="button"],[role="link"],[contenteditable="true"],[tabindex]'));
                el = candidates.find(candidate => norm(firstText(candidate)).includes(query)) || null;
            }
            if (!el) el = document.activeElement || document.body;
            if (el && typeof el.focus === 'function') {
                try { el.focus(); } catch (_) { }
            }
            const meta = keyMeta(key);
            const eventInit = { key: meta.key, code: meta.code, keyCode: meta.keyCode, which: meta.keyCode, ctrlKey: meta.ctrlKey, shiftKey: meta.shiftKey, altKey: meta.altKey, metaKey: meta.metaKey, bubbles: true, cancelable: true, composed: true };
            const down = new KeyboardEvent('keydown', eventInit);
            const press = new KeyboardEvent('keypress', eventInit);
            const up = new KeyboardEvent('keyup', eventInit);
            const downOk = el.dispatchEvent(down);
            const pressOk = el.dispatchEvent(press);
            el.dispatchEvent(up);
            if (meta.key === 'Enter' && !meta.ctrlKey && !meta.shiftKey && !meta.altKey && !meta.metaKey && downOk && pressOk && el && el.form && !(el.matches && el.matches('textarea,[contenteditable="true"]'))) {
                if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
                else if (typeof el.form.submit === 'function') el.form.submit();
            }
            return JSON.stringify({success:true,key:meta.key,code:meta.code,ctrlKey:meta.ctrlKey,shiftKey:meta.shiftKey,altKey:meta.altKey,metaKey:meta.metaKey,selector:sel || '',idx:idx || 0,id:el.id || '',tag:(el.tagName || '').toLowerCase(),text:firstText(el)});
        })();`,

        injectJS: (code) => `(function(){
            try { const r = (function(){ ${code || ''} })(); return JSON.stringify({success:true,result:r===undefined?null:r}); }
            catch(e){ return JSON.stringify({success:false,error:e.message}); }
        })();`,

        extract: (selector, format) => `(function(){
            const sel = ${JSON.stringify(selector || 'body')};
            const fmt = ${JSON.stringify(format || 'text')};
            const el = document.querySelector(sel);
            if (!el) return JSON.stringify({success:false,error:'element not found'});
            const out = fmt === 'html' ? el.innerHTML : (el.innerText || el.textContent || '');
            return JSON.stringify({success:true,length:out.length,content:out.slice(0, 4000)});
        })();`,

        scroll: (y) => `(function(){
            const y = ${JSON.stringify(y)};
            if (y === 'top') window.scrollTo(0, 0);
            else if (y === 'bottom') window.scrollTo(0, document.body.scrollHeight);
            else window.scrollTo(0, Number(y) || 0);
            return JSON.stringify({success:true,y:window.scrollY});
        })();`,
    };

    async function _execBrowser(args, ctx) {
        const action = String(args.action || args.type || 'getStructure').toLowerCase();
        const tm = global.tabManager;
        if (!tm) return { success: false, error: 'browser: tabManager not available' };

        // 一阶段：跟标签管理交互（无需 webview JS）
        if (action === 'open' || action === 'newtab' || action === 'opentab') {
            const url = args.url || 'aiview://home';
            const id = tm.createTab?.(url);
            const wv = id != null ? await _findWebviewByTabId(id) : null;
            const page = /^https?:/i.test(url) ? await _captureBrowserSnapshot(wv, args.limit) : null;
            if (page) _storeBrowserSnapshot({ id, url, title: page.title }, page);
            return { success: true, action, url, tabId: id, page };
        }
        if (action === 'switchtab' || action === 'switch') {
            let id = args.id;
            if (id == null && args.title) {
                const lower = String(args.title).toLowerCase();
                const t = (tm.tabs || []).find(x => (x.title || '').toLowerCase().includes(lower));
                if (t) id = t.id;
            }
            if (id == null) return { success: false, error: 'switchTab: no matching tab' };
            tm.activateTab?.(id);
            const t = (tm.tabs || []).find(x => x.id === id);
            const wv = await _findWebviewByTabId(id, 4, 80);
            const page = /^https?:/i.test(t?.url || '') ? await _captureBrowserSnapshot(wv, args.limit) : null;
            if (page) _storeBrowserSnapshot(t, page);
            return { success: true, action, tabId: id, title: t?.title, url: t?.url, page };
        }
        if (action === 'navigate' || action === 'goto') {
            const t = tm.getActiveTab?.();
            if (!t) return { success: false, error: 'navigate: no active tab; use action=open' };
            const wv = document.getElementById('webview-' + t.id);
            if (wv && typeof wv.loadURL === 'function' && args.url) {
                try { await wv.loadURL(args.url); } catch (e) { return { success: false, error: e.message }; }
                const page = await _captureBrowserSnapshot(wv, args.limit);
                if (page) _storeBrowserSnapshot(t, page);
                return { success: true, action, url: args.url, page };
            }
            // 兜底：新建标签
            if (args.url) {
                const tabId = tm.createTab?.(args.url);
                const page = tabId != null ? await _captureBrowserSnapshot(await _findWebviewByTabId(tabId), args.limit) : null;
                if (page) _storeBrowserSnapshot({ id: tabId, url: args.url, title: page.title }, page);
                return { success: true, action, url: args.url, fallback: 'createTab', tabId, page };
            }
            return { success: false, error: 'navigate: url required' };
        }
        if (action === 'closetab') {
            const id = args.id != null ? args.id : tm.getActiveTab?.()?.id;
            if (id == null) return { success: false, error: 'closeTab: no tab' };
            tm.closeTab?.(id);
            return { success: true, action, tabId: id };
        }
        if (action === 'gettabs' || action === 'tabs') {
            const tabs = (tm.tabs || []).map(t => ({ id: t.id, title: t.title, url: t.url, active: t.id === tm.getActiveTab?.()?.id }));
            return { success: true, action, tabs };
        }

        // 二阶段：需要 webview
        const { tab, webview } = _getActiveWebview();
        if (!webview) return { success: false, error: `browser.${action}: no active web tab (use open/navigate first)` };

        if (action === 'getstructure' || action === 'structure') {
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.getStructure(args.limit));
            if (!r.success) return r;
            try {
                const parsed = JSON.parse(r.result);
                // 标记本轮已抽取过结构（用于 ContextComposer 二阶段披露）
                try { if (global.aiChatManager) global.aiChatManager._v2DiscoveredFlags = Object.assign({}, global.aiChatManager._v2DiscoveredFlags, { browserStage2: 2 }); } catch (_) { /* ignore */ }
                _storeBrowserSnapshot(tab, parsed);
                return { success: true, action, ...parsed };
            } catch (e) { return { success: true, action, raw: r.result }; }
        }
        if (action === 'fillfield' || action === 'fill') {
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.fillField(args.selector, args.value, args.idx));
            return _parseInjectResult(r, action);
        }
        if (action === 'selectoption' || action === 'select') {
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.selectOption(args.selector, args.value, args.idx));
            return _parseInjectResult(r, action);
        }
        if (action === 'click') {
            const beforeTabId = tab?.id;
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.click(args.selector, args.idx, args.text, args.id, args.href, args.label, args.q, args.title, args.shortcut));
            const parsed = _parseInjectResult(r, action);
            if (parsed && parsed.success !== false) {
                const after = _getActiveWebview();
                const nextWebview = after.webview || webview;
                const page = await _captureBrowserSnapshot(nextWebview, args.limit);
                if (page) {
                    parsed.page = page;
                    parsed.pageChanged = !!(page.url !== (tab?.url || '') || after.tab?.id !== beforeTabId);
                    parsed.tabId = after.tab?.id != null ? after.tab.id : beforeTabId;
                    parsed.url = page.url;
                    parsed.title = page.title;
                    _storeBrowserSnapshot(after.tab || tab, page);
                }
            }
            return parsed;
        }
        if (action === 'presskey' || action === 'keypress' || action === 'key' || action === 'shortcut' || action === 'keyboard') {
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.pressKey(args.key || args.value || 'Enter', args.selector, args.idx, args.text, args.id));
            const parsed = _parseInjectResult(r, 'pressKey');
            if (parsed && parsed.success !== false && String(parsed.key || '').toLowerCase() === 'enter') {
                const after = _getActiveWebview();
                const nextWebview = after.webview || webview;
                const page = await _captureBrowserSnapshot(nextWebview, args.limit);
                if (page) {
                    parsed.page = page;
                    parsed.pageChanged = !!(page.url !== (tab?.url || '') || after.tab?.id !== tab?.id);
                    parsed.url = page.url;
                    parsed.title = page.title;
                    _storeBrowserSnapshot(after.tab || tab, page);
                }
            }
            return parsed;
        }
        if (action === 'injectjs' || action === 'inject' || action === 'eval') {
            const code = args.code || args.script || '';
            if (!code) return { success: false, error: 'injectJS: code required' };
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.injectJS(code));
            return _parseInjectResult(r, action);
        }
        if (action === 'extract' || action === 'gettext') {
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.extract(args.selector, args.format));
            return _parseInjectResult(r, action);
        }
        if (action === 'scroll') {
            const r = await _runInWebview(webview, _BROWSER_SCRIPTS.scroll(args.y == null ? 'bottom' : args.y));
            return _parseInjectResult(r, action);
        }
        return { success: false, error: `browser: unknown action "${action}"` };
    }

    function _parseInjectResult(r, action) {
        if (!r.success) return r;
        try { return Object.assign({ action }, JSON.parse(r.result)); }
        catch { return { success: true, action, raw: r.result }; }
    }

    // ── memo ───────────────────────────────────────────────
    function _monthKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    async function _execMemo(args, ctx) {
        const api = ctx.api && ctx.api.memo;
        if (!api) return { success: false, error: 'memo: electronAPI.memo unavailable' };
        // 宽松化：允许存在 args.text/args.content 且未设 action 时默认 month.append
        let rawAction = args.action || args.type || args.op || args.cmd;
        if (!rawAction && (args.text || args.content || args.note)) rawAction = 'memory.month.append';
        if (!rawAction) rawAction = 'memory.month.append';
        let action = String(rawAction).toLowerCase().replace(/_/g, '.').replace(/-/g, '.');
        // 动词别名 → 定型 operation
        const APPEND_ALIASES = ['create', 'add', 'save', 'store', 'put', 'insert', 'log', 'record', 'append', 'write'];
        const READ_ALIASES = ['read', 'get', 'list', 'show', 'view', 'fetch'];
        // 若 action 无点（单词），则根据 args.scope/section 推导
        if (!action.includes('.')) {
            const scope = String(args.scope || args.kind || 'month').toLowerCase();
            if (APPEND_ALIASES.includes(action)) action = `memory.${scope}.append`;
            else if (READ_ALIASES.includes(action)) action = `memory.${scope}.read`;
            else if (action === 'remember') action = 'memory.month.append';
            else if (action === 'recall') action = 'memory.month.read';
        }
        // 别名后缀映射
        action = action
            .replace(/\.create$|\.add$|\.save$|\.store$|\.put$|\.insert$|\.log$|\.record$|\.write$/, (m) => (m === '.write' ? '.write' : '.append'))
            .replace(/\.get$|\.list$|\.show$|\.view$|\.fetch$/, '.read');
        // text 别名
        if (args.text == null && (args.content != null || args.note != null || args.body != null)) {
            args = { ...args, text: args.content ?? args.note ?? args.body };
        }
        try {
            // memory（核心 + 长期）
            if (action === 'memory.month.append' || action === 'month.append' || action === 'remember') {
                const sec = '本月-' + _monthKey();
                const text = String(args.text || '').trim();
                if (!text) return { success: false, error: 'memo.month.append: text required' };
                const r = await api.memoryAppend(sec, text);
                return { success: true, action, section: sec, text, ...((r && typeof r === 'object') ? r : {}) };
            }
            if (action === 'memory.month.read' || action === 'month.read') {
                const all = await api.memoryRead();
                const key = '本月-' + _monthKey();
                const m = String(all || '').match(new RegExp('## ' + key + '[\\s\\S]*?(?=\\n## |$)'));
                return { success: true, action, section: key, content: m ? m[0] : '' };
            }
            if (action === 'memory.long.append' || action === 'long.append') {
                let text = String(args.text || '').trim();
                if (!text) return { success: false, error: 'memo.long.append: text required' };
                if (text.length > 200) text = text.slice(0, 200);
                const sec = String(args.section || '长期记忆');
                const r = await api.memoryAppend(sec, text);
                return { success: true, action, section: sec, text, truncated: text.length === 200, ...((r && typeof r === 'object') ? r : {}) };
            }
            if (action === 'memory.long.read' || action === 'long.read' || action === 'memory.read') {
                const all = await api.memoryRead();
                return { success: true, action, content: String(all || '') };
            }
            if (action === 'memory.long.write' || action === 'long.write' || action === 'memory.write') {
                const text = String(args.text || '');
                await api.memoryWrite(text);
                return { success: true, action, message: 'memory rewritten', length: text.length };
            }
            // schedule
            if (action === 'schedule.list') return { success: true, action, items: await api.scheduleList(args.filter) };
            if (action === 'schedule.view') return { success: true, action, items: await api.scheduleView(args.startDate, args.endDate) };
            if (action === 'schedule.add' || action === 'schedule.write') {
                const data = { title: args.title, start: args.start, end: args.end, note: args.note };
                const r = await api.scheduleWrite(args.subAction || 'add', data);
                return { success: true, action, ...((r && typeof r === 'object') ? r : { result: r }) };
            }
            // todo
            if (action === 'todo.list' || action === 'todo.read' || action === 'todo.view') {
                const r = action === 'todo.view' ? await api.todoView() : await api.todoRead();
                return { success: true, action, items: r };
            }
            if (action === 'todo.add' || action === 'todo.write' || action === 'todo.done' || action === 'todo.delete') {
                const sub = action === 'todo.add' ? 'add' : action === 'todo.done' ? 'done' : action === 'todo.delete' ? 'delete' : (args.subAction || 'add');
                const r = await api.todoWrite(sub, { title: args.title, id: args.id, priority: args.priority });
                return { success: true, action, ...((r && typeof r === 'object') ? r : { result: r }) };
            }
            // notes
            if (action === 'notes.list') return { success: true, action, items: await api.notesList() };
            if (action === 'notes.read') return { success: true, action, name: args.name, content: await api.notesRead(args.name) };
            if (action === 'notes.write') {
                await api.notesWrite(args.name, args.text || '');
                return { success: true, action, name: args.name };
            }
            if (action === 'notes.delete') {
                await api.notesDelete(args.name);
                return { success: true, action, name: args.name };
            }
            // tasks
            if (action === 'tasks.list') return { success: true, action, items: await api.tasksList() };
            if (action === 'tasks.trigger') return { success: true, action, result: await api.tasksTrigger(args.id) };
            // inbox
            if (action === 'inbox.list') return { success: true, action, items: await api.inboxList() };
            if (action === 'inbox.read' || action === 'inbox.markread') {
                const r = args.id == null ? await api.inboxMarkAllRead() : await api.inboxMarkRead(args.id);
                return { success: true, action, ...((r && typeof r === 'object') ? r : { result: r }) };
            }
            if (action === 'inbox.clear') return { success: true, action, result: await api.inboxClear() };
            return { success: false, error: `memo: unknown action "${action}"` };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    // ── subagent ───────────────────────────────────────────
    async function _execSubagent(args, ctx) {
        const prompt = String(args.prompt || args.task || '').trim();
        if (!prompt) return { success: false, error: 'subagent: prompt required' };
        const main = global.aiChatManager;
        // 懒初始化：仅在需要时创建 AIChatSubWindowManager
        let mgr = global.aiSubWindowManager;
        if (!mgr && typeof global.AIChatSubWindowManager === 'function' && main) {
            try {
                mgr = new global.AIChatSubWindowManager(main);
                global.aiSubWindowManager = mgr;
            } catch (_) { /* ignore */ }
        }
        if (!mgr) return { success: false, error: 'subagent: aiSubWindowManager not available (AIChatSubWindowManager class missing or main manager not ready)' };
        const id = mgr.createWindow();
        if (!id) return { success: false, error: 'subagent: createWindow failed (max windows reached)' };
        const win = mgr._windows.get(id);
        if (!win) return { success: false, error: 'subagent: window not found after create' };
        // 可选 scope = agent mode
        try { if (args.scope) win._setAgentMode?.(args.scope); } catch (_) { /* ignore */ }
        // 可选 model
        if (args.model && typeof args.model === 'string') win.currentModel = args.model;

        // touched files capture
        const touched = new Set();
        const onWrite = (e) => {
            try {
                const d = e.detail || {};
                if (d.subagentId === id || d.windowId === id) {
                    if (d.path) touched.add(d.path);
                }
            } catch (_) { /* ignore */ }
        };
        global.addEventListener('agentv2:file-written', onWrite);
        const prevSubId = global._currentSubagentId;
        global._currentSubagentId = id;

        // 把 prompt 写入 input 并触发 _send
        try {
            win.$.input.value = prompt;
            await win._send();
        } catch (e) {
            global.removeEventListener('agentv2:file-written', onWrite);
            global._currentSubagentId = prevSubId;
            try { if (args.closeOnDone !== false) mgr.closeWindow(id); } catch (_) { /* ignore */ }
            return { success: false, error: 'subagent send failed: ' + (e.message || e) };
        }

        // 等待 streaming 完成（轮询；超时 120s）
        const maxMs = (args.maxTurns ? args.maxTurns * 30000 : 120000);
        const deadline = Date.now() + maxMs;
        while (win._streaming && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 300));
        }
        global.removeEventListener('agentv2:file-written', onWrite);
        global._currentSubagentId = prevSubId;

        // 收集结果摘要
        const tail = (win.messages || []).slice(-3).map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content.slice(0, 400) : '',
        }));
        const lastAssistant = [...(win.messages || [])].reverse().find(m => m && m.role === 'assistant');
        const summary = (lastAssistant?.content || '').slice(0, 800);

        if (args.closeOnDone !== false) {
            try { mgr.closeWindow(id); } catch (_) { /* ignore */ }
        }
        return {
            success: !win._streaming,
            action: 'subagent',
            summary,
            touchedFiles: Array.from(touched),
            messages: tail,
            timedOut: win._streaming,
        };
    }

    /* ════════════════════════════════════════════════════════════
     *  §4 工具函数
     * ════════════════════════════════════════════════════════════ */
    function _resolvePath(ctx, p) {
        if (!p) return '';
        if (p === '.' || p === './') return ctx.getWorkspaceRoot();
        // 相对路径：拼接 workspace
        if (!_isAbsolute(p)) {
            const root = ctx.getWorkspaceRoot();
            if (!root) return p; // 没 workspace 就原样
            const sep = root.includes('\\') ? '\\' : '/';
            return root + sep + p.replace(/^\.\//, '');
        }
        return p;
    }

    function _isAbsolute(p) {
        return /^([a-zA-Z]:[\\/]|\/)/.test(p);
    }

    // 在 tabManager 的两个 viewer Map 中查找 canvas-editor viewer；兼容 viewer._editor 包裹层
    function _peelCanvas(v) {
        if (!v) return null;
        if (typeof v.getParagraphs === 'function' && typeof v.setTextStream === 'function') return v;
        if (v._editor && typeof v._editor.getParagraphs === 'function') return v._editor;
        return null;
    }
    function _findCanvasViewerForTab(tm, tabId) {
        if (!tm || tabId == null) return null;
        const draft = tm._draftEditors?.get?.(tabId);
        const peeled = _peelCanvas(draft);
        if (peeled) return peeled;
        const res = tm._resourceViewers?.get?.(tabId);
        return _peelCanvas(res);
    }

    function _simplifyEntry(e) {
        if (typeof e === 'string') return { name: e };
        return { name: e.name, isDir: !!e.isDirectory, size: e.size };
    }

    async function _treeWalk(ctx, root, maxDepth, glob) {
        const lines = [];
        async function walk(p, depth) {
            if (depth > maxDepth) return;
            const r = await ctx.api.files.readDir(p);
            const items = r?.items || r?.entries || (Array.isArray(r) ? r : []);
            for (const e of items.slice(0, 50)) {
                const name = e.name || e;
                const isDir = !!e.isDirectory;
                const indent = '  '.repeat(depth);
                lines.push(`${indent}${isDir ? '📁' : '📄'} ${name}`);
                if (isDir && depth + 1 <= maxDepth && !/^(node_modules|\.git|build|dist|arelease)$/.test(name)) {
                    const sep = p.includes('\\') ? '\\' : '/';
                    await walk(p + sep + name, depth + 1);
                }
            }
        }
        await walk(root, 0);
        return { success: true, root, depth: maxDepth, tree: lines.join('\n'), lineCount: lines.length };
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { NativeExecutor, _findCanvasViewerForTab, _peelCanvas };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
