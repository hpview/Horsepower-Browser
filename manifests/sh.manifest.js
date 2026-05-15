/**
 * V2 manifest — sh (shell/terminal)
 * Tier-0 核心：终端命令
 */
(function (global) {
    const manifest = {
        id: 'sh',
        version: '1.0.0',
        tier: 0,
        title: '终端执行',
        icon: 'terminal',
        color: '#a855f7',
        fences: ['sh', 'ai-terminal', 'ai-shell', 'ai-cmd'],
        v1Bridge: { skillId: 'terminal', codeBlockLang: 'ai-terminal' },

        coreDescription: [
            '```sh',
            '{ "cmd": "...", "cwd": "..." }',
            '```',
            '→ 在 {{terminal_kind}} 终端执行命令。{{platform}} 平台。',
        ].join('\n'),

        fullSpec: [
            '## sh — 完整字段',
            '- cmd: 字符串，单条命令；多条用 `;`（PowerShell/cmd）或 `&&`（bash）',
            '- cwd: 可选，默认工作区根',
            '- timeout: 可选毫秒数，默认 30000',
            '',
            '注意：',
            '- {{platform}}=win32 时使用 PowerShell 5.1（NEVER 用 && 链接，用 ;）',
            '- 不要用 sh 创建 PPT/XLSX/IPYNB（用 create）',
            '- 不要用 sh 写大文本文件（用 file write）',
        ].join('\n'),

        intentKeywords: ['运行', '执行', '终端', 'shell', 'powershell', 'cmd', 'npm', 'node ', 'python ', 'pip ', 'git ', '安装', '启动'],

        intentConfig: {
            keywords: ['运行', '执行', '终端', 'shell', 'powershell', 'cmd', 'npm', 'node', 'python', 'pip', 'git', '安装', '启动', 'run', 'exec', 'install'],
            contextHints: {
                editor: [],          // 与编辑器关联弱
                browser: ['localhost', '127.0.0.1', 'github.com'],
                tabs: ['terminal'],
            },
            baseScore: 0.7,
        },

        toolSchema: {
            name: 'sh',
            description: '在系统终端执行 shell 命令（Windows=PowerShell, *nix=bash）',
            parameters: {
                type: 'object',
                properties: {
                    cmd: { type: 'string', description: '要执行的命令' },
                    cwd: { type: 'string', description: '工作目录，默认工作区根' },
                    timeout: { type: 'number', description: '超时毫秒，默认 30000' },
                },
                required: ['cmd'],
            },
        },
    };

    if (global.AgentV2) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
