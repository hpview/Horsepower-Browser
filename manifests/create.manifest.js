/**
 * V2 manifest — create
 * Tier-0 核心：创建新文件（极简约定 + 高容错）
 *
 * 设计原则（用户）：类型即约定，参数全可选。
 *   { } 也行；{ "content": "..." } 也行；缺类型 → 智能推断默认 document。
 */
(function (global) {
    const manifest = {
        id: 'create',
        version: '2.0.0',
        tier: 0,
        title: '创建文件',
        icon: 'file-plus',
        color: '#10b981',
        fences: ['create', 'ai-create'],
        v1Bridge: null,
        nativeOnly: true,

        // 极简核心描述：主要 3 类直接示例，其他类型简列
        coreDescription: [
            '```create',
            '{ "type": "document|webpage|presentation", "title": "...", ... }',
            '```',
            '→ 创建新文件。**不同 type 字段不同**，请按下面格式给：',
            '- **document**（富文本文档 hdoc，类 docx）：`{ "type":"document", "title":"...", "content":"<h1>...</h1><p>...</p>" }`（content 用 HTML 片段）',
            '- **webpage**（HTML）：`{ "type":"webpage", "title":"...", "html":"<!DOCTYPE html>...完整 HTML..." }`',
            '- **presentation**（PPT pptx）：`{ "type":"presentation", "title":"...", "slides":[{"type":"bullet","title":"页标题","body":["要点1完整描述","要点2完整描述","要点3完整描述"]},...] }` ★ **slides 必须是数组**；★★ **每页 body 必须给 3-6 条完整描述**（不要只写 1-2 个词）；系统会自动加封面/目录/过渡/结尾页，AI 只需提供主体内容页',
            '- **spreadsheet**（xlsx/csv）：`{ "type":"spreadsheet", "title":"...", "sheets":[{ "name":"Sheet1", "columns":[{"header":"月份","key":"m","width":12},{"header":"金额","key":"v","width":14,"numFmt":"¥#,##0.00"}], "rows":[["1月",12000],["2月",13500]] }] }`（路径 `.csv` 写纯文本；省略 sheets 则空表）',
            '- **notebook**（ipynb）：`{ "type":"notebook", "cells":[{"type":"markdown","source":"# 标题"},{"type":"code","source":"print(1)"}] }`',
            '同类型文件已打开 → 改用 `edit`，不要 create 重建。',
            '',
            '**任务终止**：如果这一步是用户最终需要的产物，加 `"done": true` 字段（也可写 `final/deliver`），系统将不再续接对话。',
        ].join('\n'),

        fullSpec: [
            '## create — 详细约定（多数情况下不需要）',
            '- document: { content: "markdown..." }                 → .md',
            '- webpage:  { html: "..." } 或 { content: "..." }      → .html（自动打开主代码文件）',
            '- presentation: { slides: [{type, title, items?}, ...] } → .pptx（slides 可省）',
            '- spreadsheet:  { sheets:[{name, columns:[{header,key,width,numFmt}], rows:[...]}] } → .xlsx 或 .csv',
            '- notebook:     { cells: [{type:"code|markdown", source}, ...] } → .ipynb',
            '- code:         { lang: "py|js|...", content: "..." }',
            '- project:      { files: [{path, content}] }',
            '',
            '强约束：',
            '- 已打开同类型文件 → 必须用 edit，禁止 create 重建',
            '- 一次任务只 create 一次',
        ].join('\n'),

        intentKeywords: ['创建', '新建', '生成', 'create', 'new', '做一个', '做个', '帮我做', '写一份', '写一个', '简历', '路演', 'PPT', 'pptx', 'xlsx', '表格', 'notebook', '笔记本', '网页', 'html', '项目', '骨架', '文档'],

        intentConfig: {
            keywords: ['创建', '新建', '生成', 'create', 'new', '做一个', '做个', '帮我做', '写一份', '写一个', 'PPT', '表格', '笔记本', '网页', '项目', '文档'],
            contextHints: { editor: [], browser: [], tabs: [] },
            baseScore: 1.0,
        },

        toolSchema: {
            name: 'create',
            description: '创建新文件。type 可省略（自动推断）；最少传 { content } 即可',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['document', 'webpage', 'presentation', 'spreadsheet', 'notebook', 'markdown', 'code', 'project'], description: '可省略' },
                    title: { type: 'string', description: '可省略' },
                    content: { type: 'string', description: '通用文本内容' },
                    html: { type: 'string', description: 'webpage 专用' },
                    slides: { type: 'array', description: 'presentation 可选；省略则空白' },
                    sheets: { type: 'array', description: 'spreadsheet 可选；每项 {name, columns, rows}' },
                    cells: { type: 'array', description: 'notebook 可选' },
                    files: { type: 'array', description: 'project 必需' },
                    lang: { type: 'string', description: 'code 类型语言' },
                },
                required: [],
            },
        },

        examples: [
            { user: '生成一个关于项目总结的 5 页 PPT', invocation: { type: 'presentation', title: '项目总结', slides: [{ title: 'Slide 1', body: ['Point A'] }] } },
        ],
    };

    if (global.AgentV2) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
