/**
 * V2 manifest — edit
 * Tier-0 核心：修改已存在的文件（按行抽象 + str_replace 双模式）
 *
 * 设计参考：Claude Code edit_file (str_replace) + Copilot insert_edit_into_file (line-based)
 * 取两者优点：find-replace 优先（token 友好、精准），按行兜底（行号确定时更稳定）。
 */
(function (global) {
    const manifest = {
        id: 'edit',
        version: '2.0.0',
        tier: 0,
        title: '编辑已有文件',
        icon: 'file-edit',
        color: '#0ea5e9',
        fences: ['edit', 'ai-editor'],
        // Phase D step3b：edit 走 native LineEditAdapter；保留 v1Bridge 兼容旧 ai-editor 块
        nativeOnly: true,
        v1Bridge: { skillId: 'editor', codeBlockLang: 'ai-editor' },

        coreDescription: [
            '```edit',
            '{ "type":"replace", "from":10, "content":"..." }             // 替换第 10 行/段',
            '{ "type":"replace", "from":"10-12", "content":"..." }      // 替换第 10..12 行/段',
            '{ "before":10, "content":"..." }                                 // 在第 10 行/段之前插入',
            '{ "after":10, "content":"..." }                                  // 在第 10 行/段之后插入',
            '{ "type":"find-replace", "find":"旧片段", "replace":"新片段" }  // 段内小片段',
            '{ "type":"delete", "from":"10-12" }',
            '```',
            '→ 修改已有文件。**不要用来创建新文件**（用 ```create```）。target 缺省=活动标签；若目标不是当前标签，请显式传 `path`。',
            '→ 同一回复里若先执行了 `read.file(path)`，紧随其后的 `edit` 可省略 `path`，系统会继承刚读取的文件目标。',
            '',
            '**选型规则**（重要）：',
            '- 改动**整行/整段** → `from:10`；改动**连续多行/多段** → `from:"10-12"`',
            '- 填**报告/模板 section** 时，若新内容会覆盖旧标题+占位正文，必须直接用 `from:"10-15"` 覆盖整块；不要对单行使用大段多行 replace',
            '- 文档 `replace/insert/set-content` 的 `content` 必须是**纯文本段落**；不要输出 `<h1>` / `<p>` / `<ul>` 等 HTML 标签',
            '- 代码/文本/HTML 文件的 `content` 可以直接写源码或原始 HTML；上面的禁 HTML 规则**只针对文档**',
            '- 改动**段内片段**（短词、URL、数字、修饰词） → 用 `find-replace`',
            '- find-replace 仅适合**短而唯一**的片段；长内容/含格式/含换行 → 切到 `replace`',
            '',
            '**任务终止**：最终交付物加 `"done": true`，系统不再续接。',
        ].join('\n'),

        fullSpec: [
            '## edit — 6 种操作（统一 code / document / ppt / xlsx）',
            '',
            '### replace（**整行/整段替换的首选**）',
            '`{ "type":"replace", "from":10, "content":"..." }` 或 `{ "type":"replace", "from":"10-12", "content":"...新内容(可多行)..." }`',
            '- `from` 接受单个数字行号，或范围字符串 `"10-12"`；`to` 仅为旧写法兼容，不再推荐',
            '- 文档模式下：行数对齐时按段替换并保留段落格式；不对齐则纯文本重组',
            '- 文档模板/报告场景：若要填完整 section，请让 `from:"n-m"` 覆盖原 section 的标题、占位说明、空白行，不要只替换起始那一行',
            '- 文档模式：`content` 只写纯文本；若输出 HTML，系统可能容错转纯文本，但这属于错误写法，不应依赖',
            '',
            '### insertAfter（之后插入；缺省 from = 末尾追加）',
            '`{ "after":10, "content":"..." }`、`{ "type":"insertAfter", "from":10, "content":"..." }` 或 `{ "type":"insertAfter", "content":"..." }`',
            '',
            '### insert（之前插入）',
            '`{ "before":10, "content":"..." }` 或 `{ "type":"insert", "from":10, "content":"..." }`',
            '- 文档模式：`content` 只写纯文本段落，禁止 HTML',
            '',
            '### delete',
            '`{ "type":"delete", "from":10 }` 或 `{ "type":"delete", "from":"10-12" }`',
            '',
            '### find-replace（**段内小片段**）',
            '`{ "type":"find-replace", "find":"旧片段", "replace":"新片段" }`',
            '- find 必须**唯一匹配**（多次出现则拒绝）',
            '- ⚠️ 长内容/含换行/带格式 → 改用 `replace`',
            '- ⚠️ 文档模式：find/replace 必须是**纯文本**（禁止 HTML 标签）',
            '',
            '### read',
            '`{ "type":"read", "from":1 }` 或 `{ "type":"read", "from":"1-50" }`',
            '- 文档输出格式：`行号: 文本`（如 `5: ...`）；后续 edit 优先直接写数字行号，系统会在批量执行前自动锁定稳定段锚点',
            '',
            '### set-content（**慎用**，整篇覆盖）',
            '`{ "type":"set-content", "content":"..." }`',
            '- 文档模式：`content` 只写纯文本全文，禁止 HTML',
            '',
            '## 多 edit 同回复内的稳健性',
            '- 推荐只写数字行号：`{"type":"replace", "from":"10-12", ...}`；系统会在执行前把它绑定到稳定段落',
            '- 多个 edit 若仍用纯数字行号，**按起始行从大到小**排列更稳',
            '',
            '## target 解析',
            '省略=活动标签 → 同回复最近一次 `read.file(path)` → `tab:42` → 绝对路径 → 文件名/标签 title 模糊匹配 → 工作区相对路径',
            '',
            '## 类型差异',
            '- **code/txt/md/html**：物理文件按行操作；若该文件已在 Monaco 打开，编辑会同步更新打开的 model',
            '- **document(hdoc/docx)**：一段=一行；段 id 在 viewer 内持久稳定',
            '- **pptx**：slide:N.title / slide:N.body 路径化定位',
            '- **xlsx**：sheet:Name!A1 单元格定位',
        ].join('\n'),

        intentKeywords: ['修改', '编辑', '改一下', '改成', '替换', 'edit', 'modify', 'update', '加一段', '删掉', '把第', '第几行', '换成'],

        // ── 上下文敏感 fullSpec：PPT/XLSX 标签页时返回专属语法 ──
        computeFullSpec(ctx) {
            const editorType = ctx?.editor?.type;
            if (editorType === 'ppt') {
                return [
                    '## edit — PPT 专用路径语法',
                    '',
                    'PPT 不能按行操作，必须用 `from` 路径定位幻灯片或元素：',
                    '',
                    '### 读取',
                    '`{"type":"read","from":"slide:N"}` → 列出第 N 页所有元素：`#ID 类型 文字预览`',
                    '`{"type":"read","from":"slide:N.element:ID"}` → 读取该元素完整文本',
                    '',
                    '### 改文本（首选）',
                    '- 改标题：`{"type":"replace","from":"slide:N.title","content":"新标题"}`',
                    '- 改正文/项目列表：`{"type":"replace","from":"slide:N.body","content":"第一行\\n第二行"}`（每行 = 一个项目）',
                    '- 改具体元素：`{"type":"replace","from":"slide:N.element:ID.text","content":"..."}`',
                    '',
                    '### 增删幻灯片',
                    '- 在第 N 页之后插入：`{"type":"insertAfter","from":"slide:N","content":"{type:\'bullet\', title:..., bullets:[...]}"}`',
                    '- content 必须是单页 slide JSON（参见 create.pptx slides 字段格式）',
                    '- 删除整页：`{"type":"delete","from":"slide:N"}`',
                    '',
                    '### 注意',
                    '- 禁止用 `set-content` 整篇覆写 PPT — 会摧毁所有版式',
                    '- 单回复尽量只改 1~3 处；改完一处后 stage→deck 会自动同步并触发重渲染',
                    '- find-replace 仅适合短而唯一的字串（如把 "v1" 全局换成 "v2"）',
                ].join('\n');
            }
            if (editorType === 'xlsx') {
                return [
                    '## edit — XLSX 专用路径语法',
                    '',
                    'XLSX 用 A1 风格地址，可选 sheet 名前缀：`sheet:Name!A1` 或 `Name!A1`，省略 sheet 时取活动 sheet。',
                    '',
                    '### 读取',
                    '`{"type":"read","from":"sheet:Name!A1:E20"}` → 输出 TSV（行内 \\t 分隔，多行 \\n 分隔）',
                    '`{"type":"read","from":"sheet:Name"}` → 输出该 sheet 整体维度 + 前 50 行 TSV 预览',
                    '',
                    '### 写入',
                    '- 写单格：`{"type":"replace","from":"sheet:Name!B5","content":"123"}`（公式：`"=SUM(B2:B4)"`）',
                    '- 写区域：`{"type":"replace","from":"sheet:Name!A1:C3","content":"a\\tb\\tc\\nd\\te\\tf\\n..."}`',
                    '- find-replace：`{"type":"find-replace","from":"sheet:Name","find":"旧值","replace":"新值"}`（仅在文本单元格搜索）',
                    '',
                    '### 增删 Sheet',
                    '- 新增 sheet：`{"type":"insertAfter","from":"sheet:Last","content":"NewSheetName"}`',
                    '- 删除 sheet：`{"type":"delete","from":"sheet:Name"}`',
                    '',
                    '### 创建图表',
                    '`{"type":"insert","from":"sheet:Name!chart","content":"{type:\'bar\', range:\'A1:C5\', title:\'季度营收\', categoryAxis:\'A\', anchor:\'E2\'}"}`',
                    '- 类型支持 bar/line/pie/area；range 必须是连续矩形，首行/列做表头',
                    '',
                    '### 注意',
                    '- 不要用 `set-content`（会清空所有 sheet）',
                    '- 大批量数据写入：尽量一次写整个区域（TSV），不要逐格写',
                ].join('\n');
            }
            return manifest.fullSpec; // 默认走通用 fullSpec
        },

        intentConfig: {
            keywords: ['修改', '编辑', '改一下', '改成', '替换', 'edit', 'modify', 'update', '加一段', '删掉', '把第', '第几行', '换成', '插入'],
            contextHints: {
                editor: ['.pptx', '.xlsx', '.ipynb', '.docx', '.md', '.html', '.js', '.ts', '.py', '.hdoc'],
                browser: [],
                tabs: ['editor'],
            },
            baseScore: 0.6,
        },

        toolSchema: {
            name: 'edit',
            description: '修改已打开的文件（首选 find-replace；行号已知时用 replace）',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['read', 'insert', 'insertAfter', 'replace', 'find-replace', 'set-content', 'delete'] },
                    target: { type: 'string', description: '省略=当前活动标签；或 tab:<id>/绝对路径/文件名/标签 title' },
                    from: { type: ['number', 'string'], description: '单个行/段写数字，如 12；连续范围写字符串，如 "12-15"。to 仅旧写法兼容' },
                    before: { type: ['number', 'string'], description: '插入别名：等价于在该行/段之前插入；可省略 type' },
                    after: { type: ['number', 'string'], description: '插入别名：等价于在该行/段之后插入；可省略 type' },
                    to: { type: ['number', 'string'], description: '旧写法兼容；新写法优先把范围写进 from，如 "12-15"' },
                    at: { type: 'string', description: 'insert 旧写法：start|end|line:N' },
                    content: { type: 'string' },
                    find: { type: 'string' },
                    replace: { type: 'string' },
                    all: { type: 'boolean' },
                    regex: { type: 'boolean' },
                },
                required: [],
            },
        },

        examples: [
            { user: '把 README 里 v1.0 全部改成 v2.0', invocation: { type: 'find-replace', target: 'README.md', find: 'v1.0', replace: 'v2.0' } },
            { user: '在文件末尾追加一行注释', invocation: { type: 'insertAfter', content: '// done' } },
            { user: '在第 5 段之前插入一段', invocation: { before: 5, content: '新段落内容' } },
            { user: '在第 5 段之后插入一段', invocation: { after: 5, content: '新段落内容' } },
            { user: '替换第 5 到 7 段', invocation: { type: 'replace', from: '5-7', content: '新的三段内容' } },
            { user: '删除当前文件第 10 到 12 行', invocation: { type: 'delete', from: '10-12' } },
        ],
    };

    if (global.AgentV2) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);

