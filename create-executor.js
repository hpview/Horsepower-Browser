/**
 * AgentV2 — CreateExecutor
 *
 * native create 执行器：极简容错 + 类型即约定
 *
 * 设计原则（来自用户）：
 *   - 类型本身就是约定，参数全可选
 *   - { content } 也行，{} 也行，最少要能落到默认模板
 *   - 主要类型：document / webpage / presentation
 *   - 次要类型：spreadsheet / notebook / markdown / code
 *   - 类型缺失 → 智能推断；推断不出 → 默认 document
 *   - 内容缺失 → 模板默认占位
 *   - 主题/参数错误 → 静默回退默认值
 *
 * 文件结构：
 *   §1 类型规范化 + 后缀映射
 *   §2 主入口 CreateExecutor.execute()
 *   §3 各类型实现（pptx/xlsx/ipynb/webpage/document/code/markdown/project）
 *   §4 工具函数
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 类型规范化
     * ════════════════════════════════════════════════════════════ */
    // 别名 → 规范类型
    const TYPE_ALIASES = {
        ppt: 'presentation', pptx: 'presentation', slides: 'presentation', '演示': 'presentation', '演示文稿': 'presentation',
        excel: 'spreadsheet', xlsx: 'spreadsheet', sheet: 'spreadsheet', '表格': 'spreadsheet',
        ipynb: 'notebook', jupyter: 'notebook', '笔记本': 'notebook',
        web: 'webpage', html: 'webpage', site: 'webpage', '网站': 'webpage', '网页': 'webpage',
        doc: 'document', docx: 'document', word: 'document', '文档': 'document',
        md: 'markdown', markdown: 'markdown',
        py: 'code', js: 'code', ts: 'code', '代码': 'code', script: 'code',
        proj: 'project', '项目': 'project',
    };

    // 规范类型 → 默认扩展名 + 类别
    const TYPE_META = {
        presentation: { ext: '.pptx', category: 'pptx', defaultTitle: '演示文稿', dual: false },
        spreadsheet: { ext: '.xlsx', category: 'xlsx', defaultTitle: '工作表', dual: false },
        notebook: { ext: '.ipynb', category: 'notebook', defaultTitle: '笔记本', dual: true, primaryView: 'notebook' },
        webpage: { ext: '.html', category: 'webpage', defaultTitle: '网页', dual: true, primaryView: 'code' },
        document: { ext: '.hdoc', category: 'document', defaultTitle: '文档', dual: false, useDocumentManager: true },
        markdown: { ext: '.md', category: 'document', defaultTitle: '文档', dual: false },
        code: { ext: '.js', category: 'code', defaultTitle: 'script', dual: false },
        project: { ext: '', category: 'project', defaultTitle: '项目', dual: false },
    };

    /* ════════════════════════════════════════════════════════════
     *  §2 主入口
     * ════════════════════════════════════════════════════════════ */
    class CreateExecutor {
        constructor({ electronAPI, openInTab } = {}) {
            this.api = electronAPI || global.electronAPI || null;
            // openInTab: 注入的"打开标签页"回调；renderer 中通常是 tabManager.createTab
            this.openInTab = openInTab || null;
        }

        /**
         * @param {object} args - { type?, title?, content?, slides?, cells?, html?, files?, theme?, ... }
         * @returns {Promise<{success, type, path?, error?, opened?, primary?}>}
         */
        async execute(args = {}) {
            const norm = _normalize(args);
            const handler = HANDLERS[norm.type];
            if (!handler) return { success: false, error: `create: unsupported type ${norm.type}` };
            try {
                return await handler(norm, this);
            } catch (e) {
                return { success: false, type: norm.type, error: e.message || String(e) };
            }
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 类型规范化 + 智能推断
     * ════════════════════════════════════════════════════════════ */
    function _normalize(args) {
        let type = String(args.type || '').toLowerCase().trim();
        type = TYPE_ALIASES[type] || type;
        if (!TYPE_META[type]) type = _inferType(args); // 类型缺失 / 错误 → 推断
        const meta = TYPE_META[type];
        const title = String(args.title || meta.defaultTitle).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || meta.defaultTitle;
        return { ...args, type, title, _meta: meta };
    }

    /** 智能推断：根据 args 内容形状推断类型 */
    function _inferType(args) {
        if (Array.isArray(args.slides)) return 'presentation';
        if (Array.isArray(args.cells)) return 'notebook';
        if (Array.isArray(args.sheets) || Array.isArray(args.rows)) return 'spreadsheet';
        if (typeof args.html === 'string') return 'webpage';
        if (Array.isArray(args.files)) return 'project';
        const c = typeof args.content === 'string' ? args.content.trim() : '';
        if (c.startsWith('<!DOCTYPE') || c.startsWith('<html')) return 'webpage';
        if (/^#\s|^##\s/m.test(c)) return 'markdown';
        // 默认：文档
        return 'document';
    }

    /* ════════════════════════════════════════════════════════════
     *  §4 各类型实现
     * ════════════════════════════════════════════════════════════ */
    const HANDLERS = {
        presentation: _createPresentation,
        spreadsheet: _createSpreadsheet,
        notebook: _createNotebook,
        webpage: _createWebpage,
        document: _createDocumentHdoc,   // 走 hdoc 文档编辑器（与 V1 ai-create document 一致）
        markdown: _createMarkdown,       // .md 纯文本
        code: _createCode,
        project: _createProject,
    };

    async function _createPresentation(n, ctx) {
        const dest = await _resolvePath(ctx, n);
        if (!dest) return { success: false, type: n.type, error: 'cannot resolve path' };

        // ── 兜底：当模型把 PPT 内容塞在 content/html 字符串里（HTML 整页）时，自动拆 slide ──
        let slidesArr = Array.isArray(n.slides) ? n.slides : null;
        if (!slidesArr) {
            const htmlSrc = typeof n.html === 'string' ? n.html
                : (typeof n.content === 'string' && /<\w+[\s>]/.test(n.content) ? n.content : null);
            if (htmlSrc) {
                slidesArr = _slidesFromHtml(htmlSrc, n.title);
            } else if (typeof n.content === 'string' && n.content.trim()) {
                // 纯文本：按双换行拆为 slide
                slidesArr = n.content.split(/\n{2,}/).map((para, i) => {
                    const lines = para.split(/\n+/).filter(Boolean);
                    return { type: 'bullet', title: lines[0] || `第 ${i + 1} 页`, body: lines.slice(1) };
                });
            }
        }

        const payload = {
            path: dest.path,
            title: n.title,
            aspectRatio: n.aspectRatio || '16:9',
            templateId: n.templateId || 'ppt-blank',
            theme: n.theme || null,
            slides: Array.isArray(slidesArr) ? slidesArr.map(_normalizeSlide) : undefined,
        };
        const r = await ctx.api.workbench.createEmptyPptx(payload);
        if (r && r.error) return { success: false, type: 'presentation', error: r.error, path: dest.path };
        await _openCreated(ctx, dest.path, 'presentation');
        return { success: true, type: 'presentation', path: dest.path, title: n.title, slidesCount: payload.slides?.length || 0 };
    }

    /**
     * HTML 整页 → slide 数组
     * 策略：以 <h1>/<h2> 为分页点，section 内取 <p>/<li> 作 body
     */
    function _slidesFromHtml(html, defaultTitle) {
        const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        // 去掉 head/style/script
        let body = html.replace(/<head[\s\S]*?<\/head>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<script[\s\S]*?<\/script>/gi, '');
        // 优先 .slide 容器
        const slideContainers = body.match(/<div[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi);
        const sections = [];
        if (slideContainers && slideContainers.length) {
            sections.push(...slideContainers);
        } else {
            // 按 <h1>/<h2> 拆
            const parts = body.split(/(?=<h[12][\s>])/i);
            for (const p of parts) if (p.trim()) sections.push(p);
        }
        const slides = [];
        for (const sec of sections) {
            const titleMatch = sec.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
            const subMatch = sec.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/i);
            const liMatches = [...sec.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => stripTags(m[1])).filter(Boolean);
            const pMatches = [...sec.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripTags(m[1])).filter(Boolean);
            const body = liMatches.length ? liMatches : pMatches;
            slides.push({
                type: 'bullet',
                title: titleMatch ? stripTags(titleMatch[1]) : (defaultTitle || ''),
                subtitle: subMatch ? stripTags(subMatch[1]) : undefined,
                body: body.slice(0, 8),
            });
        }
        return slides.length ? slides : [{ type: 'cover', title: defaultTitle || 'PPT' }];
    }

    /**
     * 把模型千变万化的 slide 字段规范化为 main.js collectBodyItems 能识别的结构
     * 兼容：
     *   slide.content = "..."（字符串）→ subtitle 或 body
     *   slide.content = [{type:'bullet', items:[]}, {type:'text', text:''}, ...]（嵌套数组）→ 展平到 body[]
     *   slide.body / slide.items / slide.bullets → 直通
     */
    function _normalizeSlide(s) {
        if (!s || typeof s !== 'object') return { type: 'bullet', title: String(s || '') };
        const out = { ...s };
        // 推断 layout/type
        if (!out.type && !out.layout) out.type = 'bullet';
        if (out.layout && !out.type) { out.type = out.layout; }

        // ── 关键：嵌套 content[] 数组 → 展平 ──
        if (Array.isArray(out.content)) {
            const body = [];
            let titleFromContent = null;
            for (const c of out.content) {
                if (typeof c === 'string') { body.push(c); continue; }
                if (!c || typeof c !== 'object') continue;
                const ct = String(c.type || '').toLowerCase();
                if (ct === 'title' || ct === 'heading' || ct === 'h1' || ct === 'h2') {
                    if (!titleFromContent) titleFromContent = c.text || c.content || '';
                } else if (ct === 'subtitle') {
                    if (!out.subtitle) out.subtitle = c.text || c.content || '';
                } else if (ct === 'bullet' || ct === 'list' || ct === 'bullets') {
                    const items = Array.isArray(c.items) ? c.items : (typeof c.items === 'string' ? c.items.split(/\r?\n+/) : []);
                    items.forEach(it => body.push(typeof it === 'string' ? it : (it.text || it.title || '')));
                } else if (ct === 'text' || ct === 'paragraph' || ct === 'p') {
                    if (c.text) body.push(c.text);
                } else if (Array.isArray(c.items)) {
                    c.items.forEach(it => body.push(typeof it === 'string' ? it : (it.text || it.title || '')));
                } else if (c.text) {
                    body.push(c.text);
                }
            }
            if (!out.title && titleFromContent) out.title = titleFromContent;
            out.body = body.length ? body : (out.body || []);
            // 删除原始嵌套 content（防止 main.js 把它当字符串处理出错）
            delete out.content;
        }

        // 字符串 content + 多行 → 转 body（main.js 已会处理，这里冗余但安全）
        if (typeof out.content === 'string' && /\r?\n/.test(out.content) && !out.body) {
            out.body = out.content.split(/\r?\n+/).map(l => l.replace(/^\s*[•·*\-\d+\.\)]+\s*/, '').trim()).filter(Boolean);
        }

        // items 数组里的对象 → 提取 text
        if (Array.isArray(out.items)) {
            out.items = out.items.map(it => typeof it === 'string' ? it : (it.text || it.title || it.content || ''));
        }
        return out;
    }

    async function _createSpreadsheet(n, ctx) {
        const dest = await _resolvePath(ctx, n);
        if (!dest) return { success: false, type: n.type, error: 'cannot resolve path' };
        const ext = (dest.path.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
        const sheets = Array.isArray(n.sheets) ? n.sheets : null;

        // CSV：直接写文本（首个 sheet）
        if (ext === '.csv') {
            const sh = (sheets && sheets[0]) || { columns: [], rows: [] };
            const cols = Array.isArray(sh.columns) ? sh.columns : [];
            const rows = Array.isArray(sh.rows) ? sh.rows : [];
            const esc = (v) => {
                if (v == null) return '';
                const s = String(v);
                return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            };
            const lines = [];
            if (cols.length) lines.push(cols.map(c => esc(c.header || c.key || '')).join(','));
            for (const row of rows) {
                if (Array.isArray(row)) lines.push(row.map(esc).join(','));
                else if (row && typeof row === 'object') {
                    const keys = cols.length ? cols.map(c => c.key || c.header) : Object.keys(row);
                    lines.push(keys.map(k => esc(row[k])).join(','));
                }
            }
            const r = await ctx.api.files.writeFile(dest.path, lines.join('\n') + '\n', 'utf8');
            if (r && r.success === false) return { success: false, type: 'spreadsheet', error: r.error, path: dest.path };
            await _openCreated(ctx, dest.path, 'spreadsheet');
            return { success: true, type: 'spreadsheet', path: dest.path, title: n.title, format: 'csv' };
        }

        // XLSX：携带 sheets payload（若有）
        const arg = sheets && sheets.length ? { path: dest.path, sheets } : dest.path;
        const r = await ctx.api.workbench.createEmptyXlsx(arg);
        if (r && r.error) return { success: false, type: 'spreadsheet', error: r.error, path: dest.path };
        await _openCreated(ctx, dest.path, 'spreadsheet');
        return { success: true, type: 'spreadsheet', path: dest.path, title: n.title };
    }

    async function _createNotebook(n, ctx) {
        const dest = await _resolvePath(ctx, n);
        if (!dest) return { success: false, type: n.type, error: 'cannot resolve path' };
        const cells = Array.isArray(n.cells) && n.cells.length
            ? n.cells.map(_normalizeCell)
            : [_normalizeCell({ type: 'markdown', source: `# ${n.title}\n\n` })];
        const ipynb = {
            cells,
            metadata: {
                kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
                language_info: { name: 'python' },
            },
            nbformat: 4,
            nbformat_minor: 5,
        };
        const r = await ctx.api.files.writeFile(dest.path, JSON.stringify(ipynb, null, 2), 'utf8');
        if (r && r.success === false) return { success: false, type: 'notebook', error: r.error };
        await _openCreated(ctx, dest.path, 'notebook');
        return { success: true, type: 'notebook', path: dest.path, cellsCount: cells.length };
    }

    function _normalizeCell(c) {
        const type = (c?.cell_type || c?.type || 'code').toLowerCase();
        const isMd = type === 'markdown' || type === 'md' || type === 'text';
        const source = c?.source ?? c?.content ?? c?.code ?? '';
        const lines = (typeof source === 'string' ? source.split('\n') : Array.isArray(source) ? source : ['']).map(l => l.endsWith('\n') ? l : l + '\n');
        if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\n$/, '');
        return isMd
            ? { cell_type: 'markdown', metadata: {}, source: lines }
            : { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: lines };
    }

    async function _createWebpage(n, ctx) {
        const dest = await _resolvePath(ctx, n);
        if (!dest) return { success: false, type: n.type, error: 'cannot resolve path' };
        let html = typeof n.html === 'string' ? n.html : null;
        if (!html) {
            const body = typeof n.content === 'string' ? n.content : `<h1>${_esc(n.title)}</h1>\n<p>使用 edit 修改本页内容。</p>`;
            html = _wrapHtml(n.title, body);
        } else if (!/<html[\s>]/i.test(html)) {
            html = _wrapHtml(n.title, html);
        }
        const r = await ctx.api.files.writeFile(dest.path, html, 'utf8');
        if (r && r.success === false) return { success: false, type: 'webpage', error: r.error };
        // 网页：双视图 — 自动打开主代码文件（与 ipynb 类似）
        await _openCreated(ctx, dest.path, 'webpage', { primary: 'code' });
        return { success: true, type: 'webpage', path: dest.path, primary: 'code', size: html.length };
    }

    function _wrapHtml(title, body) {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${_esc(title)}</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;line-height:1.7;color:#222}h1{border-bottom:2px solid #444;padding-bottom:.4rem}</style>
</head>
<body>
${body}
</body>
</html>
`;
    }

    function _esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    /** document 默认走 hdoc 文档编辑器（content 可为 HTML 或 markdown） */
    async function _createDocumentHdoc(n, ctx) {
        const dfm = global.documentFileManager;
        // 内容预处理：若 content 是 markdown（无 HTML 标签），简单转 HTML
        let html = typeof n.content === 'string' && n.content.trim() ? n.content : '';
        if (typeof n.html === 'string' && n.html.trim()) html = n.html;
        if (!html) html = `<h1>${_esc(n.title)}</h1>\n<p>使用 edit 修改本文档。</p>`;
        if (!/<[a-z][\s\S]*>/i.test(html)) html = _mdToBasicHtml(html);

        // 首选：documentFileManager（持久化 hdoc）
        if (dfm?.createManagedDocument) {
            try {
                const result = await dfm.createManagedDocument({ title: n.title, html });
                if (result?.path && global.tabManager) {
                    try { global.tabManager.createTab(`aiview://document-editor?file=${encodeURIComponent(result.path)}`); } catch { /* ignore */ }
                }
                return { success: true, type: 'document', path: result?.path || null, title: n.title, format: 'hdoc' };
            } catch (e) {
                return { success: false, type: 'document', error: e.message };
            }
        }
        // 回退：documentDraftStore 临时草稿
        if (global.documentDraftStore && global.tabManager) {
            const draftId = 'ai-' + Date.now();
            global.documentDraftStore.set(draftId, { title: n.title, html, orientation: n.orientation || 'portrait' });
            try { global.tabManager.createTab(`aiview://document-draft?draft=${draftId}`); } catch { /* ignore */ }
            return { success: true, type: 'document', draftId, title: n.title };
        }
        // 测试环境：写到本地 .hdoc（仅作占位）
        const dest = await _resolvePath(ctx, n);
        if (!dest) return { success: false, type: 'document', error: 'cannot resolve path' };
        await ctx.api.files.writeFile(dest.path, html, 'utf8');
        return { success: true, type: 'document', path: dest.path, title: n.title, format: 'hdoc' };
    }

    /** 极简 markdown → HTML（仅处理 # / ## / 段落，足够 fallback） */
    function _mdToBasicHtml(md) {
        const lines = String(md).split(/\r?\n/);
        const out = [];
        for (const line of lines) {
            const m1 = /^#\s+(.*)$/.exec(line);
            const m2 = /^##\s+(.*)$/.exec(line);
            const m3 = /^###\s+(.*)$/.exec(line);
            if (m1) out.push(`<h1>${_esc(m1[1])}</h1>`);
            else if (m2) out.push(`<h2>${_esc(m2[1])}</h2>`);
            else if (m3) out.push(`<h3>${_esc(m3[1])}</h3>`);
            else if (line.trim()) out.push(`<p>${_esc(line)}</p>`);
        }
        return out.join('\n') || `<p>${_esc(md)}</p>`;
    }

    /** markdown：纯 .md 文本 */
    async function _createMarkdown(n, ctx) {
        const dest = await _resolvePath(ctx, n);
        if (!dest) return { success: false, type: 'markdown', error: 'cannot resolve path' };
        const md = typeof n.content === 'string' && n.content.trim()
            ? n.content
            : `# ${n.title}\n\n（使用 edit 修改本文档）\n`;
        const r = await ctx.api.files.writeFile(dest.path, md, 'utf8');
        if (r && r.success === false) return { success: false, type: 'markdown', error: r.error };
        await _openCreated(ctx, dest.path, 'markdown');
        return { success: true, type: 'markdown', path: dest.path, size: md.length };
    }

    async function _createCode(n, ctx) {
        // 优先 args.lang 决定后缀
        const lang = String(n.lang || n.language || 'js').toLowerCase().replace(/^\.+/, '');
        const extMap = { js: '.js', ts: '.ts', py: '.py', python: '.py', java: '.java', go: '.go', rs: '.rs', cpp: '.cpp', c: '.c', json: '.json', yaml: '.yml' };
        const ext = extMap[lang] || `.${lang}`;
        const meta = { ...n._meta, ext };
        const dest = await _resolvePath(ctx, { ...n, _meta: meta });
        if (!dest) return { success: false, type: 'code', error: 'cannot resolve path' };
        const code = typeof n.content === 'string' ? n.content : `// ${n.title}\n`;
        const r = await ctx.api.files.writeFile(dest.path, code, 'utf8');
        if (r && r.success === false) return { success: false, type: 'code', error: r.error };
        await _openCreated(ctx, dest.path, 'code');
        return { success: true, type: 'code', path: dest.path, lang, size: code.length };
    }

    async function _createProject(n, ctx) {
        // files: [{ path, content }]
        if (!Array.isArray(n.files) || n.files.length === 0) {
            return { success: false, type: 'project', error: 'project: files[] required' };
        }
        const baseDir = (await _resolveBaseDir(ctx, n));
        const written = [];
        for (const f of n.files) {
            if (!f?.path) continue;
            const sep = baseDir.includes('\\') ? '\\' : '/';
            const fp = baseDir + sep + String(f.path).replace(/^[\\/]+/, '');
            await ctx.api.files.mkdir?.(_dirname(fp));
            const r = await ctx.api.files.writeFile(fp, f.content || '', 'utf8');
            if (!r || r.success !== false) written.push(fp);
        }
        // 自动打开第一个非 README 的文件作为 primary
        const primary = written.find(p => !/readme/i.test(p)) || written[0];
        if (primary) await _openCreated(ctx, primary, 'project');
        return { success: true, type: 'project', baseDir, fileCount: written.length, primary };
    }

    /* ════════════════════════════════════════════════════════════
     *  §5 工具函数
     * ════════════════════════════════════════════════════════════ */
    async function _resolvePath(ctx, n) {
        if (n.path) return { path: n.path, dir: _dirname(n.path) };
        const meta = n._meta;
        if (!ctx.api?.workbench?.resolveDefaultPath) {
            // 测试环境无 IPC：放工作区根
            const root = (global.workspacePanel?.getRoot?.()) || '.';
            const sep = root.includes('\\') ? '\\' : '/';
            return { path: `${root}${sep}${n.title}${meta.ext}`, dir: root };
        }
        const r = await ctx.api.workbench.resolveDefaultPath({
            category: meta.category,
            ext: meta.ext,
            baseName: n.title,
        });
        if (r?.error || !r?.path) return null;
        return { path: r.path, dir: r.dir };
    }

    async function _resolveBaseDir(ctx, n) {
        if (n.path) return n.path;
        if (!ctx.api?.workbench?.resolveDefaultPath) {
            const root = (global.workspacePanel?.getRoot?.()) || '.';
            const sep = root.includes('\\') ? '\\' : '/';
            return `${root}${sep}${n.title}`;
        }
        const r = await ctx.api.workbench.resolveDefaultPath({ category: 'project', ext: '', baseName: n.title });
        return r?.path || `./${n.title}`;
    }

    function _dirname(p) {
        const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return i >= 0 ? p.slice(0, i) : '.';
    }

    async function _openCreated(ctx, filePath, type, opts) {
        if (!ctx.openInTab) {
            // 自动尝试 global.tabManager
            const tm = global.tabManager;
            if (tm?.createTab) {
                try { tm.createTab(`resource://file/${filePath.replace(/\\/g, '/')}`, { type, ...(opts || {}) }); } catch { /* ignore */ }
            }
            return;
        }
        try { await ctx.openInTab(filePath, type, opts); } catch { /* ignore */ }
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { CreateExecutor };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
