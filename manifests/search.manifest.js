/**
 * V2 manifest — search
 * Tier-0 核心：批量搜索（一次多关键词）
 *
 * 语法糖：fence ```grep``` / ```web``` / ```files``` 自动锁定 mode
 * 标准入口：fence ```search``` 配 mode 字段
 */
(function (global) {
    const manifest = {
        id: 'search',
        version: '2.0.0',
        tier: 0,
        title: '搜索',
        icon: 'search',
        color: '#ec4899',
        // grep/web/files 是语法糖；ai-search 兼容旧调用
        fences: ['search', 'grep', 'web', 'files', 'ai-search'],
        v1Bridge: null,
        nativeOnly: true,

        coreDescription: [
            '## 三种搜索（**用动词本身定调**，不要混用）',
            '',
            '```grep',
            '{ "queries": ["TODO", "FIXME"], "path": "src", "glob": "**/*.js" }',
            '```',
            '→ **工作区文本搜索**。返回文件路径 + 行号 + 片段；用于"我不知道这段代码在哪"。',
            '',
            '```web',
            '{ "queries": ["大语言模型 2025", "多模态架构"], "engine": "auto" }',
            '```',
            '→ **网页搜索**。返回 **结构化结果数组** results:[{rank,title,url,snippet,source,fetched?}]；',
            '   top-3 与高价值域名（百科/wikipedia/MDN 等）会静默 prefetch 净化正文（≤ 1500 字）到 fetched.content。',
            '   需更深入某条结果时，直接对 results[i].url 发 ```read``` 。',
            '',
            '```files',
            '{ "queries": ["*.pptx", "report*.md"] }',
            '```',
            '→ **按文件名搜索**。返回路径列表；用于"我知道大致名字"。',
            '',
            '标准入口（带配置时使用）：```search``` { "mode":"grep|web|files", "queries":[...] }',
        ].join('\n'),

        fullSpec: [
            '## search 完整字段',
            '- mode=grep:  { queries:[], path?:".", glob?:"**/*.js", maxResultsPerQuery?:30 }',
            '- mode=web:   { queries:[], engine?:"auto|multi|bing|baidu|google|sogou|duckduckgo|wikipedia|baikebaidu|github|zhihu|...", maxResults?:10 }',
            '          engine=auto：根据查询词与会话话题记忆智能选引擎（默认）',
            '          engine=multi：扇出 2–3 个引擎并用 RRF 合并去重',
            '- mode=files: { queries:[], path?:".", glob?:"..." } 按名匹配',
            '',
            '语法糖：```grep```/```web```/```files``` fence 自动设 mode；',
            '若同时给 mode 字段且与 fence 冲突，**fence 优先**。',
            '',
            '一次多关键词比多次单关键词快很多（节省 token / 网络往返）。',
            '',
            'search 的结果会附带可寻址的 path/url；后续可用 ```read``` 直接读取。',
        ].join('\n'),

        intentKeywords: ['搜索', '查找', '查一下', '看看', '哪里有', 'search', 'find', 'grep', 'lookup', '搜', '检索'],

        intentConfig: {
            keywords: ['搜索', '查找', '查一下', '看看', '哪里有', 'search', 'find', 'grep', 'lookup', '批量搜', '同时搜', '检索', '查词', '搜网页', '搜代码'],
            contextHints: {
                editor: ['.js', '.ts', '.py', '.md', '.json'],
                browser: ['google.com', 'bing.com', 'baidu.com', 'github.com'],
            },
            baseScore: 0.6,
        },

        toolSchema: {
            name: 'search',
            description: '一次搜索多个关键词（grep 工作区 / web 网络 / files 文件名）',
            parameters: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['grep', 'web', 'files', 'workspace'] },
                    queries: { type: 'array', items: { type: 'string' } },
                    path: { type: 'string' },
                    glob: { type: 'string' },
                    engine: { type: 'string', enum: ['auto', 'multi', 'bing', 'baidu', 'google', 'sogou', 'duckduckgo', 'wikipedia', 'baikebaidu', 'github', 'zhihu', 'google-scholar', 'csdn', 'stackoverflow'] },
                    maxResults: { type: 'number' },
                },
                required: ['queries'],
            },
        },

        examples: [
            { user: '在 src 里查 TODO 和 FIXME', invocation: { mode: 'grep', queries: ['TODO', 'FIXME'], path: 'src' } },
            { user: '搜一下大模型推理加速的文档', invocation: { mode: 'web', queries: ['LLM inference acceleration 2025'], engine: 'auto' } },
            { user: '查一下量子纠缠是什么', invocation: { mode: 'web', queries: ['量子纠缠'], engine: 'multi' } },
        ],
    };

    if (global.AgentV2) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);

