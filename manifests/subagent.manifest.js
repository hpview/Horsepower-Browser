/**
 * V2 manifest — subagent (子代理)
 * Tier-2：关键词触发后披露；不复用 V1 SubAgentSkill。
 *
 * 执行：NativeExecutor._execSubagent → AIChatSubWindowManager.createWindow，
 *       直接复用主对话同构的子窗口跑一次完整对话，再回收 {touchedFiles, lastTurns, summary}。
 */
(function (global) {
    const manifest = {
        id: 'subagent',
        version: '1.0.0',
        tier: 1,
        title: '子代理',
        icon: 'bot',
        color: '#a855f7',
        fences: ['subagent'],
        nativeOnly: true,

        coreDescription: [
            '```subagent',
            '{ "prompt": "..." }',
            '```',
            '→ 派遣一个子代理独立完成子任务，返回结果摘要；提到「子代理/分解任务/并行」时披露详细字段。',
        ].join('\n'),

        fullSpec: [
            '## subagent — 完整字段',
            '- `prompt` 子任务描述（必填）',
            '- `model` 可选指定模型；省则继承主对话',
            '- `scope` 可选：`browser` / `code` / `chat` / `full` 决定子代理 Agent 模式（默认继承）',
            '- `maxTurns` 可选最大轮数，默认 8',
            '- `closeOnDone` 默认 true，结束后自动关闭子窗口',
            '',
            '返回：',
            '- `success` 是否完成',
            '- `summary` 末尾 2-3 段摘要（≤800 字）',
            '- `touchedFiles` 子代理写入/修改的文件路径数组',
            '- `messages` 子代理对话末尾若干条（仅含 role/content 摘要）',
            '',
            '⚠️ 子代理是高容错的："prompt 写错也能跑"；不要把核心任务交给子代理。',
        ].join('\n'),

        intentKeywords: ['子代理', 'subagent', '子任务', '分解任务', '并行任务', '派遣', '让另一个 ai'],

        intentConfig: {
            keywords: ['子代理', 'subagent', '子任务', '分解任务', '并行任务', '派遣', '另一个ai'],
            contextHints: {},
            baseScore: 0.4,
        },

        toolSchema: {
            name: 'subagent',
            description: '派遣子代理独立完成子任务，返回 {summary, touchedFiles}',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string' },
                    model: { type: 'string' },
                    scope: { type: 'string' },
                    maxTurns: { type: 'number' },
                    closeOnDone: { type: 'boolean' },
                },
                required: ['prompt'],
            },
        },
    };

    if (global.AgentV2 && global.AgentV2.registerManifest) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
