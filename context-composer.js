/**
 * AgentV2 — ContextComposer
 *
 * 职责：拼装系统提示词，按 Tier 分层 + 意图驱动替换式注入
 *
 * 设计要点：
 *   - Tier-0 始终常驻（核心 4 件套）
 *   - Tier-1 一行 summary 列出其余 skill
 *   - Tier-2 仅注入本轮意图相关 spec（替换式，不堆积）
 *   - 失败重试：lastFailedIntents 在 TTL=2 内强制保留
 *
 * 文件结构：
 *   §1 配置（模板、TTL）
 *   §2 主入口 compose()
 *   §3 各 Tier 拼装函数
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 配置
     * ════════════════════════════════════════════════════════════ */
    const RETRY_TTL = 2; // 失败后保留 N 轮

    const HEADER_TEMPLATE = (env) => [
        `# Horsepower Agent (V2 Engine)`,
        `日期: ${env.date}  平台: ${env.platform}  终端: ${env.terminal}`,
        `工作区: ${env.workspaceRoot || '(无)'}`,
        !env.workspaceRoot ? `⚠️ 当前**没有工作区**：\`file\` / \`grep\` / \`folder\` 等基于路径的操作不可用。\n   → 请改用 \`page\` / \`tab\` / \`abstract\` 读取上下文，或先让用户打开文件夹。` : '',
        env.workspaceTree ? `\n## 工作区一级目录\n${env.workspaceTree}` : '',
    ].filter(Boolean).join('\n');

    /** 标签页/编辑器/浏览器上下文 → 紧凑文本 */
    function _formatTabContext({ editor, browser, tabs }) {
        const lines = [];
        const formatBrowserItem = (item) => {
            if (!item) return '';
            const primary = item.label || item.text || item.title || item.id || item.href || '(无文本)';
            const extras = [];
            if (item.idx != null) extras.push('#' + item.idx);
            if (item.shortcut) extras.push('key=' + item.shortcut);
            if (item.id) extras.push('id=' + item.id);
            return `${primary}${extras.length ? ' [' + extras.join(', ') + ']' : ''}`;
        };
        if (editor) {
            lines.push(`## 当前活动编辑器（${editor.type}）`);
            const f = editor.filePath || editor.title || '(未命名)';
            lines.push(`- 文件: ${f}`);
            if (editor.type === 'monaco') {
                lines.push(`- 语言: ${editor.language || '?'}; 光标: ${editor.cursor?.line ?? '?'}:${editor.cursor?.column ?? '?'}`);
                if (editor.selectedText) lines.push(`- 选中(截断): ${editor.selectedText.replace(/\n/g, '⏎')}`);
                lines.push(`- 编辑方式：\`edit\` fence。单行修改用 \`from:12\`；连续多行用 \`from:"12-15"\`；插入可直接写 \`before:12\` / \`after:12\`；行内片段用 \`find-replace\``);
                lines.push(`- 代码/文本文件允许在 \`content\` 中写原始源码或 HTML；**不要套用文档专用的“纯文本禁 HTML”规则**`);
                lines.push(`- 目标不是当前活动代码标签时，请显式带 \`path\`；只有在**同一回复**里刚执行过 \`read.file(path)\` 时，紧随其后的 \`edit\` 才可以省略 \`path\``);
            } else if (editor.type === 'document' || editor.type === 'canvas') {
                lines.push(`- 字数≈${editor.wordCount ?? '?'}; ${editor.dirty ? '已修改' : '已保存'}`);
                if (editor.selectedText) lines.push(`- 选中(截断): ${editor.selectedText.replace(/\n/g, '⏎')}`);
                lines.push(`- 编辑方式（**文档专用**）：`);
                lines.push(`  1. 先用 \`{"type":"read","from":1,"to":N}\` 读取，输出 \`行号: 文本\``);
                lines.push(`  2. ⚠️ **read 与 edit 不能放在同一回复**：先发 read 块，**等系统返回结果**再发 edit；否则 edit 用的 id 都是猜的，必失败`);
                lines.push(`  3. 改**整段** → \`from:12\`；改**连续多段**（含换行/标题/列表）→ \`from:"12-15"\`；插入可直接写 \`before:12\` 或 \`after:12\`；系统会在内部自动锁定稳定段落`);
                lines.push(`  4. 改**段内短片段**（词、URL、数字）→ \`find-replace\`（纯文本，禁止 HTML 标签，且必须唯一）`);
                lines.push(`  5. ⚠️ 文档 \`replace/insert/set-content\` 的 \`content\` **只能写纯文本段落**；禁止输出 \`<h1>\`、\`<p>\`、\`<ul>\` 这类 HTML`);
                lines.push(`  6. ⚠️ \`content\` 里**只写正文**——绝对不要带 \`12:\` 这类行首编号（那是 read 输出格式，写时不需要）`);
                lines.push(`  7. ⚠️ 长内容（>1 段或含换行）**禁止用 find-replace**（几乎必失败）`);
                lines.push(`  8. ⚠️ 填报告/模板 section 时，**不要**用 \`from:12\` 往单行里塞整节内容；应改用覆盖整块旧占位内容的 \`from:"12-18"\``);
                lines.push(`  9. ⚠️ 一次回复多个 edit：**只在改互不相邻的段时才合并**；改邻近/重叠区域请**只发一个 edit**，等回执后再发下一个`);
            } else if (editor.type === 'ppt') {
                lines.push(`- 幻灯片数: ${editor.slideCount ?? '?'}; 当前页: ${editor.currentSlide ?? 1}`);
                if (Array.isArray(editor.slidesPreview) && editor.slidesPreview.length) {
                    const preview = editor.slidesPreview.slice(0, 6).map((s, i) => `#${i + 1} ${(s.title || s.text || '').slice(0, 36)}`).join(' | ');
                    lines.push(`- 预览: ${preview}`);
                }
                lines.push(`- 编辑方式（**PPT 专用**），用 \`edit\` fence + 路径式 \`from\`：`);
                lines.push(`  1. 先 \`{"type":"read"}\`（不带 from）→ 看到所有页的结构化文本：每文本块标记为 \`[t1·title] 内容\` / \`[t2·body] 内容\``);
                lines.push(`  2. 看某页详情 → \`{"type":"read","from":"slide:N"}\` 返回该页全部文本块 + 元素清单`);
                lines.push(`  3. 改标题 → \`{"type":"replace","from":"slide:N.title","content":"新标题"}\``);
                lines.push(`  4. 改第 K 个文本块 → \`{"type":"replace","from":"slide:N.tK","content":"..."}\` (按 read 输出的 t1/t2/t3 标签)`);
                lines.push(`  5. 改正文（多块按行映射）→ \`{"type":"replace","from":"slide:N.body","content":"第一段\\n第二段\\n第三段"}\``);
                lines.push(`  6. 该页无文本块时 \`replace .body\` 会**自动追加**一个新文本元素到空闲位置`);
                lines.push(`  7. 追加正文文本 → \`{"type":"insert","from":"slide:N","content":"...纯文本"}\` (空闲位置插入新文本元素)`);
                lines.push(`  8. 插整页 → \`{"type":"insertAfter","from":"slide:N","content":"{\\"title\\":\\"…\\",\\"bullets\\":[\\"…\\"]}"}\` (content 必须以 \`{\` 开头的 JSON)`);
                lines.push(`  9. 改具体元素 → \`{"type":"replace","from":"slide:N.element:ELEM_ID.text","content":"..."}\``);
                lines.push(`  10. 删整页 → \`{"type":"delete","from":"slide:N"}\``);
                lines.push(`  11. **重新生成单页**（保留原页，在其后插入修改版，另存为新文件）→ \`{"type":"regenerate","from":"slide:N","spec":{"title":"...","body":["...","..."],"type":"bullet"}}\``);
                lines.push(`  12. **重新生成整套 PPT**（生成全新 .pptx，不破坏原文件）→ \`{"type":"regenerate","from":"all","title":"...","slides":[{...},{...}]}\``);
                lines.push(`  13. ⚠️ 真实 schema：text 元素用 \`runs[].text\`，shape 用 \`text.runs[].text\`，table 用 \`rows[r][c].runs[].text\`；adapter 已自动处理`);
            } else if (editor.type === 'xlsx') {
                const sheets = editor.sheets || [];
                lines.push(`- Sheet: ${editor.activeSheet || '?'} / ${sheets.length} 个 (${sheets.slice(0, 4).join(', ')}${sheets.length > 4 ? '…' : ''})`);
                if (editor.dimensions) lines.push(`- 当前 Sheet 维度: ${editor.dimensions}`);
                lines.push(`- 编辑方式（**XLSX 专用**），用 \`edit\` fence + 路径式 \`from\`：`);
                lines.push(`  1. 读区域 → \`{"type":"read","from":"sheet:Name!A1:E20"}\`（输出 TSV 文本）`);
                lines.push(`  2. 写单格 → \`{"type":"replace","from":"sheet:Name!B5","content":"123"}\` 或公式 \`"=SUM(B2:B4)"\``);
                lines.push(`  3. 写区域 → \`{"type":"replace","from":"sheet:Name!A1:C3","content":"a\\tb\\tc\\nd\\te\\tf\\n..."}\` (TSV)`);
                lines.push(`  4. 新增 Sheet → \`{"type":"insertAfter","from":"sheet:LastName","content":"NewSheetName"}\``);
                lines.push(`  5. 删除 Sheet → \`{"type":"delete","from":"sheet:Name"}\``);
                lines.push(`  6. 创建图表 → \`{"type":"insert","from":"sheet:Name!chart","content":"{type:'bar', range:'A1:C5', title:'…'}"}\``);
                lines.push(`  7. 单元格地址必须是 A1 风格（含可选 sheet 名 + !），不要写中文坐标`);
            }
            lines.push('');
        }
        if (browser) {
            lines.push(`## 当前活动网页`);
            lines.push(`- 标题: ${browser.title || '(无)'}`);
            lines.push(`- URL: ${browser.url || '(无)'}`);
            lines.push(`- 操作方式：可直接使用 \`browser\` 执行网页交互。常见流程是先 \`{"action":"getStructure"}\`，再用 \`click/fillField/selectOption/pressKey/extract\` 按 selector、idx、文字、id 或题干操作页面`);
            if (browser.count) lines.push(`- 最新页面快照: ${browser.count} 个交互节点（仅保留当前页最新快照，不叠加旧页）`);
            if (Array.isArray(browser.buttons) && browser.buttons.length) {
                lines.push(`- 按钮/可点击项: ${browser.buttons.slice(0, 8).map(formatBrowserItem).join(' | ')}`);
            }
            if (Array.isArray(browser.links) && browser.links.length) {
                lines.push(`- 链接: ${browser.links.slice(0, 6).map(formatBrowserItem).join(' | ')}`);
            }
            if (Array.isArray(browser.texts) && browser.texts.length) {
                lines.push(`- 纯文本摘要: ${browser.texts.slice(0, 6).map(formatBrowserItem).join(' | ')}`);
            }
            if (browser.searchHints && Array.isArray(browser.searchHints.engines) && browser.searchHints.engines.length) {
                lines.push(`- 相关搜索引擎: ${browser.searchHints.engines.map(e => `${e.name}(${e.id}): ${e.url}`).join(' | ')}`);
                if (browser.searchHints.default) lines.push(`- 默认搜索引擎: ${browser.searchHints.default}`);
            }
            lines.push('');
        }
        if (tabs && (tabs.all?.length || tabs.recent?.length)) {
            if (Array.isArray(tabs.all) && tabs.all.length) {
                lines.push(`## 打开的标签页（${tabs.all.length}）`);
                for (const t of tabs.all) {
                    const flag = t.active ? '★' : (t.split ? '◧' : ' ');
                    lines.push(`- ${flag} [${t.type}] ${t.title}${t.url && t.type === 'webpage' ? '  ' + t.url : ''}`);
                }
            }
            if (Array.isArray(tabs.recent) && tabs.recent.length) {
                lines.push(`## 最近访问的资源`);
                for (const r of tabs.recent.slice(0, 10)) {
                    lines.push(`- [${r.type || '?'}] ${r.title || ''} ${r.path ? '— ' + r.path : ''}`);
                }
            }
            lines.push('');
        }
        if (lines.length === 0) return '';
        lines.push('### 操作选择提示');
        lines.push('- **基于标签页**的操作（编辑文档/PPT/表格、读取网页正文）：先确认当前活动标签是否就是目标；若不是，**告知用户切换**或在回答中提示标签页 id');
        lines.push('- **基于文件**的操作（创建新文件、跨工作区读写）：使用 `create` / `file` / `edit` 并传 `filePath`，需在工作区或刚创建的目录');
        return lines.join('\n');
    }

    const CONSTRAINT_TEMPLATE = [
        '## 强约束',
        '- PPT/XLSX/IPYNB → **必须**用 `create`，禁止用 `file write` 拼装',
        '- 已打开同类型文件 → **必须**用 `edit`，禁止 `create` 重建',
        '- 一次任务只 create 一次文件，不要重复',
        '- **文档（hdoc/docx）禁止 raw read**：直接 read 文件路径会被拒绝；请用 `read.page` 或 `edit.read`（活动标签）',
        '- 任何“执行 JavaScript / 运行 JS / require 模块 / 用户已给出 script 调用示例”的请求 → **必须**用 `script` fence；普通 `javascript` / `js` 代码块只会展示，绝不执行',
        '- 用户消息里如果已经给了完整 `script` JSON，请优先原样复用；不要改写成 `create`、不要退回成解释性代码示例',
        '- 当前平台 {{platform}}，终端 {{terminal_kind}}（win32 用 `;` 链接命令，不要 `&&`）',
    ].join('\n');

    /* ════════════════════════════════════════════════════════════
     *  §2 主入口
     * ════════════════════════════════════════════════════════════ */
    class ContextComposer {
        /**
         * @param {object} deps
         * @param {V2Registry} deps.registry
         * @param {IntentDetector} deps.intentDetector
         */
        constructor({ registry, intentDetector }) {
            this.registry = registry;
            this.intentDetector = intentDetector;
            /** 上轮失败重试 spec ttl */
            this._retainSpecs = new Map(); // manifestId -> remainingTurns
        }

        /**
         * @param {object} input
         * @param {string} input.userMsg - 当前用户消息
         * @param {string} [input.llmHint] - 上轮 LLM 输出
         * @param {object} [input.env] - 环境信息 { date, platform, terminal, workspaceRoot, workspaceTree }
         * @param {string[]} [input.failedManifests] - 上轮失败的 manifestIds（用于强制保留 spec）
         * @returns {{ systemPrompt: string, debug: object }}
         */
        compose(input) { return _compose(this, input); }

        /** 标记本轮失败的 spec，以便下轮强制注入（TTL=2） */
        markFailed(manifestIds) {
            for (const id of manifestIds || []) {
                this._retainSpecs.set(id, RETRY_TTL);
            }
        }

        /** 每轮调用一次：retainSpecs 计数减 1 */
        tick() {
            for (const [id, ttl] of this._retainSpecs.entries()) {
                if (ttl <= 1) this._retainSpecs.delete(id);
                else this._retainSpecs.set(id, ttl - 1);
            }
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 实现
     * ════════════════════════════════════════════════════════════ */
    function _compose(self, input = {}) {
        const { userMsg = '', llmHint = '', env = {}, failedManifests = [], discoveredFlags = {} } = input;
        const parts = [];
        const manifestMode = (manifest) => _getManifestMode(input, manifest);
        const promptEnabled = (manifest) => manifestMode(manifest) !== 'disabled';

        // ── Tier-0 Header ──
        parts.push(HEADER_TEMPLATE(_resolveEnv(env)));

        // ── 标签页 / 编辑器 / 浏览器上下文 ──
        const tabCtx = _formatTabContext({
            editor: input.editor,
            browser: input.browser,
            tabs: input.tabs,
        });
        if (tabCtx) parts.push('\n' + tabCtx);

        // ── Tier-0 核心常驻：4 件套 ──
        parts.push('\n## 核心调用语法（始终可用，无需披露）\n');
        for (const m of self.registry.byTier(0).filter(promptEnabled)) {
            parts.push(_substituteEnv(m.coreDescription || '', env));
            parts.push('');
        }

        // ── Tier-1 元信息：其余 skill 一行 summary ──
        const tier1AndAbove = [...self.registry.byTier(1), ...self.registry.byTier(2), ...self.registry.byTier(3)].filter(promptEnabled);
        if (tier1AndAbove.length > 0) {
            parts.push('## 其他可用能力（关键词触发后会披露详细用法）\n');
            for (const m of tier1AndAbove) {
                const fence = (m.fences && m.fences[0]) || m.id;
                parts.push(`- \`${fence}\` — ${m.title || m.id}`);
            }
            parts.push('');
        }

        // ── Phase D：用户脚本 / Skill 列表（L1 始终展示名字）──
        try {
            const skillReg = global.AgentV2?.skillRegistry;
            const cfg = global.AgentV2?.ScriptRuntimeConfig?.disclosure || {};
            if (skillReg && cfg.l1AlwaysShow !== false) {
                const allSkills = skillReg.list();
                const meta = global.AgentV2?.ScriptRuntimeConfig?.metaSkillHint || {};
                const lowMsg = (userMsg || '').toLowerCase();
                const strictHit = (meta.strictKeywords || []).some(k => lowMsg.includes(String(k).toLowerCase()));
                // 默认隐藏 meta-skill；命中严格关键词时再展示
                const userSkills = allSkills.filter(s => {
                    if (s.id === (meta.metaSkillId || 'meta-skill')) return strictHit;
                    if (s.kind === 'builtin' && !strictHit) return false;
                    return true;
                });
                if (userSkills.length > 0) {
                    const fold = cfg.l1FoldThreshold || 20;
                    parts.push('## 已注册 Skill（L1：仅名字；用 `script {name:"id.fn",args:{...}}` 调用）\n');
                    if (userSkills.length > fold) {
                        parts.push(`- 共 **${userSkills.length}** 个 skill；用 \`script {"name":"meta.listSkills"}\` 查看完整列表`);
                        // 展示头部 fold-1 项作为预览
                        userSkills.slice(0, fold - 1).forEach(s => {
                            parts.push(`- \`skill:${s.id}\` — ${s.name}${s.description ? ' · ' + s.description.slice(0, 40) : ''}`);
                        });
                        parts.push(`- ...(+${userSkills.length - fold + 1})`);
                    } else {
                        userSkills.forEach(s => {
                            parts.push(`- \`skill:${s.id}\` — ${s.name}${s.description ? ' · ' + s.description.slice(0, 60) : ''}`);
                        });
                    }
                    parts.push('');
                }

                // Meta-skill 自举提示：仅在上一轮 success / 用户提到关键词时注入
                const dflags = discoveredFlags || {};
                const hitKeyword = (meta.userKeywords || []).some(k => lowMsg.includes(String(k).toLowerCase()));
                const hitSuccess = !!(meta.promptAfterSuccess && dflags.scriptLastSuccess);
                if (hitKeyword || hitSuccess) {
                    parts.push('> 💡 **可保存为 skill**：刚才的脚本可以注册成可复用 skill，下次会话也能调用：');
                    parts.push('> `script {"name":"meta.createSkill","args":{"id":"<kebab-id>","name":"<人类名>","description":"...","scripts":[{"name":"main","params":[],"code":"..."}]}}`');
                    parts.push('');
                }
            }
        } catch (e) { /* swallow disclosure errors */ }

        // ── Tier-2 触发披露：意图驱动（多源综合 + 评分分级） ──
        const intent = self.intentDetector.detect({
            userMsg,
            llmHint,
            env,
            editor: input.editor,
            browser: input.browser,
            tabs: input.tabs,
            recentManifestIds: input.recentManifestIds || [],
            failedManifestIds: failedManifests,
        });
        // disclosure: { id, level: 'full'|'core'|'oneline' }
        const levelById = new Map();
        for (const d of (intent.disclosures || [])) {
            const m = self.registry.get(d.id);
            if (m && promptEnabled(m)) levelById.set(d.id, d.level);
        }
        // 强制保留失败重试的 spec → full
        for (const id of failedManifests) {
            const m = self.registry.get(id);
            if (m && promptEnabled(m)) levelById.set(id, 'full');
        }
        for (const id of self._retainSpecs.keys()) {
            const m = self.registry.get(id);
            if (m && promptEnabled(m) && !levelById.has(id)) levelById.set(id, 'full');
        }

        if (levelById.size > 0) {
            parts.push('## 本轮相关详细说明\n');
            const intentCtx = { userMsg, llmHint, env, editor: input.editor, browser: input.browser, tabs: input.tabs };
            for (const [id, level] of levelById) {
                const m = self.registry.get(id);
                if (!m || !promptEnabled(m)) continue;
                // 动态 fullSpec：manifest 可提供 computeFullSpec(ctx)
                const dynamicFull = (typeof m.computeFullSpec === 'function')
                    ? m.computeFullSpec(intentCtx) || ''
                    : '';
                if (level === 'full' && (dynamicFull || m.fullSpec)) {
                    parts.push(dynamicFull || m.fullSpec, '');
                } else if (level === 'core' && m.coreDescription) {
                    parts.push(_substituteEnv(m.coreDescription, env), '');
                } else {
                    const fence = (m.fences && m.fences[0]) || m.id;
                    parts.push(`- \`${fence}\` — ${m.title || m.id}`);
                }
                // 二阶段披露（如 browser.stage2Spec）——仅在 discoveredFlags 包含对应项时追加
                const stage2Key = id + 'Stage2'; // 例：browserStage2
                if (m.stage2Spec && discoveredFlags[stage2Key]) {
                    parts.push(m.stage2Spec, '');
                }
            }
        }

        const gated = (self.registry.all ? self.registry.all() : []).filter(m => promptEnabled(m) && manifestMode(m) !== 'immediate');
        if (gated.length > 0) {
            parts.push('## 技能执行模式提示\n');
            for (const m of gated) {
                const mode = manifestMode(m);
                const fence = (m.fences && m.fences[0]) || m.id;
                const label = mode === 'manual' ? '手动确认' : '会话结束执行';
                parts.push(`- \`${fence}\` 当前为${label}模式：可以输出对应代码块让界面排队/展示，但不要假设已自动执行。`);
            }
            parts.push('');
        }

        // ── 强约束 ──
        parts.push(_substituteEnv(CONSTRAINT_TEMPLATE, env));

        const systemPrompt = parts.join('\n').replace(/\n{3,}/g, '\n\n');
        return {
            systemPrompt,
            debug: {
                tier0Count: self.registry.byTier(0).filter(promptEnabled).length,
                tier1PlusCount: tier1AndAbove.length,
                disclosedIds: Array.from(levelById.keys()),
                disabledIds: (self.registry.all ? self.registry.all() : []).filter(m => manifestMode(m) === 'disabled').map(m => m.id),
                gatedIds: gated.map(m => m.id),
                disclosures: intent.disclosures || [],
                intentScores: Array.from(intent.scores.entries()),
                retainedRetry: Array.from(self._retainSpecs.entries()),
                approxTokens: Math.ceil(systemPrompt.length / 3.5),
            },
        };
    }

    function _resolveEnv(env) {
        const now = new Date();
        let dateTime = env.date || '';
        if (!dateTime) {
            try {
                const fmt = now.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
                dateTime = `${fmt} ${weekday}`;
            } catch (_) {
                dateTime = now.toISOString().slice(0, 16).replace('T', ' ');
            }
        }
        return {
            date: dateTime,
            platform: env.platform || (typeof process !== 'undefined' ? process.platform : 'unknown'),
            terminal: env.terminal || _guessTerminal(env.platform),
            workspaceRoot: env.workspaceRoot || '',
            workspaceTree: env.workspaceTree || '',
        };
    }

    function _guessTerminal(platform) {
        if (platform === 'win32') return 'PowerShell 5.1';
        if (platform === 'darwin') return 'zsh';
        return 'bash';
    }

    function _substituteEnv(template, env) {
        if (!template) return '';
        const e = _resolveEnv(env);
        return template
            .replace(/\{\{platform\}\}/g, e.platform)
            .replace(/\{\{terminal_kind\}\}/g, e.terminal)
            .replace(/\{\{date\}\}/g, e.date);
    }

    function _getManifestMode(input, manifest) {
        let mode = 'immediate';
        try {
            const resolver = input.getManifestMode || input.manifestModeOf;
            if (typeof resolver === 'function') mode = resolver(manifest.id, manifest) || mode;
        } catch (_) { /* ignore */ }
        if (mode === 'auto') return 'immediate';
        return ['immediate', 'after-turn', 'manual', 'disabled'].includes(mode) ? mode : 'immediate';
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { ContextComposer };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
