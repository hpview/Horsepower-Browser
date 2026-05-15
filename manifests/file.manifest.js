/**
 * V2 manifest — file
 * Tier-0 核心：文件系统读写（轻量纯文本/源码）
 */
(function (global) {
    const manifest = {
        id: 'file',
        version: '1.0.0',
        tier: 0,
        title: '文件系统操作',
        icon: 'folder-tree',
        color: '#f59e0b',
        fences: ['file', 'ai-file', 'ai-files'],
        v1Bridge: { skillId: 'file', codeBlockLang: 'ai-file' },

        coreDescription: [
            '```file',
            '{ "type": "read|write|list|tree|grep|mkdir|delete|stat", "path": "...", ... }',
            '```',
            '→ 文件系统操作。**禁止**用于生成 .pptx/.xlsx/.ipynb（必须用 create）。',
        ].join('\n'),

        fullSpec: [
            '## file — 完整字段',
            '- read:   { type:"read", path:"...", encoding?:"utf8|base64" }',
            '- write:  { type:"write", path:"...", content:"...", append?:bool }',
            '- list:   { type:"list", path:".", limit?:200 }',
            '- tree:   { type:"tree", path:".", depth?:2 } → 多级目录结构',
            '- grep:   { type:"grep", pattern:"...", path:".", glob?:"**/*.js", maxResults?:50 }',
            '- mkdir:  { type:"mkdir", path:"..." }',
            '- delete: { type:"delete", path:"..." } (谨慎)',
            '- stat:   { type:"stat", path:"..." }',
            '',
            'path 支持相对路径（基于工作区根）和绝对路径。',
        ].join('\n'),

        intentKeywords: ['读取', '查看文件', '搜索代码', '列出', '目录', 'grep', '查找', 'list', 'read', 'write', '保存到', '写入'],

        intentConfig: {
            keywords: ['读取', '查看文件', '搜索代码', '列出', '目录', 'grep', '查找', 'list', 'read', 'write', '保存到', '写入', 'tree', 'mkdir', 'stat'],
            contextHints: {
                editor: [],
                browser: ['file://'],
                tabs: ['file-explorer', 'workspace'],
            },
            baseScore: 0.7,
        },

        toolSchema: {
            name: 'file',
            description: '文件系统操作（读/写/列/树/grep/mkdir/delete/stat）',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['read', 'write', 'list', 'tree', 'grep', 'search', 'mkdir', 'delete', 'stat'] },
                    path: { type: 'string' },
                    content: { type: 'string', description: 'write 时使用' },
                    pattern: { type: 'string', description: 'grep 关键词' },
                    glob: { type: 'string' },
                    depth: { type: 'number', description: 'tree 深度' },
                    encoding: { type: 'string' },
                },
                required: ['type', 'path'],
            },
        },
    };

    if (global.AgentV2) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
