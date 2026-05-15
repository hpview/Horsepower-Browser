/**
 * V2 manifest — read
 * Tier-0 核心：读取信息（与 search 互补；动词模式名不重叠）
 *
 * 5 种 fence（动词即行为）：
 *   ```read```     标准入口，配 mode 字段
 *   ```file```     读文件 / 文件夹结构
 *   ```page```     读当前/指定网页摘要
 *   ```tab```      读指定标签页摘要（编辑器/资源/网页通吃）
 *   ```abstract``` 工作区 + 全部标签 + 当前页 一次性概览
 *
 * 与 search 区别：
 *   - search：我不知道路径 / 想找东西 → 返回路径列表
 *   - read：我已知路径或标签 → 返回内容/摘要
 *   - search 的结果可直接喂给 read（路径/url 一致）
 */
(function (global) {
    const manifest = {
        id: 'read',
        version: '1.0.0',
        tier: 0,
        title: '读取',
        icon: 'book-open',
        color: '#8b5cf6',
        fences: ['read', 'page', 'tab', 'abstract', 'file-read'],
        // 注意：'file' 已被 file.manifest 占用（写入操作），所以这里改名 'file-read'
        // 其实更直观就是统一进 read：```read``` { "mode":"file", ... }
        // 但语法糖：'page' / 'tab' / 'abstract' 仍可直接当作 fence 用
        v1Bridge: null,
        nativeOnly: true,

        coreDescription: [
            '## 读取（与 search 互补）',
            '',
            '```read',
            '{ "mode": "file|folder|page|tab|abstract", ... }',
            '```',
            '',
            '语法糖：```page``` ```tab``` ```abstract``` 直接当 fence 用，省 mode 字段。',
            '',
            '- **abstract**（默认推荐先调一次）：返回工作区 + 标签页 + 当前页 综合摘要',
            '  `{ "mode":"abstract" }` 或 `{ "mode":"abstract", "target":"workspace|tabs|page" }`',
            '- **file**：指定路径 → 读文件内容（按行）；指定文件夹 → 读结构',
            '  `{ "mode":"file", "path":"src/utils.js", "from":1, "to":50 }`',
            '  `{ "mode":"file", "path":"src" }`（文件夹：一级条目 + 同后缀聚合，过多则截断）',
            '- **page**：读**当前活动标签**的"页面摘要"——网页→主文本；文档→按段落输出；资源文件→按行',
            '  `{ "mode":"page" }`（**空块也可以**：```page```\\n```）；指定网页：`{ "mode":"page", "url":"..." }`',
            '- **tab**：读指定标签页',
            '  `{ "mode":"tab", "id":42 }` 或 `{ "mode":"tab", "title":"index.js" }`',
        ].join('\n'),

        fullSpec: [
            '## read 完整字段',
            '- mode=abstract:  { target?: "workspace|tabs|page", limit?: 20 }',
            '- mode=file:      { path: "...", from?:1, to?:200, encoding?:"utf8" }',
            '- mode=folder:    { path: "...", maxDepth?:1, maxPerExt?:8 }（mode=file 路径是文件夹时自动转 folder）',
            '- mode=page:      { url?: "..." } 缺省=当前活动 webpage 标签',
            '- mode=tab:       { id?: number, title?: string } 优先 id，否则模糊匹配 title',
            '',
            '与 search 配合：',
            '  search → 得到 { path / url } 列表',
            '  read   → 选其中一个详读',
            '',
            '注意：',
            '- workspace 未打开时 file/folder 失败，请改用 abstract / page / tab',
            '- abstract 用于初次了解上下文，不要在每轮重复调用（系统提示已带 header）',
        ].join('\n'),

        intentKeywords: ['看看', '读取', '读一下', '展示', '内容', '摘要', '概览', '什么内容', 'show', 'open', 'view'],

        intentConfig: {
            keywords: ['看看', '读取', '读一下', '展示', '什么内容', '摘要', '概览', '是什么', 'show', 'view', 'read'],
            contextHints: { editor: [], browser: [], tabs: [] },
            baseScore: 0.5,
        },

        toolSchema: {
            name: 'read',
            description: '读取文件/网页/标签内容或工作区摘要',
            parameters: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['abstract', 'file', 'folder', 'page', 'tab'] },
                    path: { type: 'string' },
                    from: { type: 'number' },
                    to: { type: 'number' },
                    url: { type: 'string' },
                    id: { type: 'number' },
                    title: { type: 'string' },
                    target: { type: 'string', enum: ['workspace', 'tabs', 'page'] },
                    limit: { type: 'number' },
                    maxDepth: { type: 'number' },
                    maxPerExt: { type: 'number' },
                },
                required: ['mode'],
            },
        },

        examples: [
            { user: '当前情况是怎样的？', invocation: { mode: 'abstract' } },
            { user: '看看 utils.js 前 50 行', invocation: { mode: 'file', path: 'src/utils.js', to: 50 } },
            { user: '当前网页主要讲什么？', invocation: { mode: 'page' } },
        ],
    };

    if (global.AgentV2) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
