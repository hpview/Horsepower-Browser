/**
 * V2 manifest — memo (记忆与日程)
 * Tier-2：关键词级精细披露
 *
 * 核心常驻仅暴露 `memory.month.append`（本月记忆）。
 * 其他能力（长期记忆 / 日程 / 待办 / 笔记 / 收件箱 / 任务）必须命中关键词后才披露。
 *
 * 长期记忆每次硬截断 200 字。
 *
 * 系统提示词中会额外注入「## 本月记忆」「## 长期记忆」全文（由 ai-chat.js 完成）。
 */
(function (global) {
    // 关键词 → 披露段映射（ContextComposer 通过 m.computeFullSpec(ctx) 调用）
    const SECTIONS = {
        long: [
            '## memo.memory.long — 长期记忆',
            '- `{"action":"memory.long.append","section":"用户偏好","text":"..."}` 追加（**自动截断 200 字**）',
            '- `{"action":"memory.long.read"}` 读取全文',
            '- `{"action":"memory.long.write","text":"..."}` 全量覆盖（慎用）',
            '⚠️ 长期记忆一旦写入难以删除，内容应稳定、低频；**临时事项请用 month.append**。',
        ].join('\n'),
        schedule: [
            '## memo.schedule — 日程',
            '- `{"action":"schedule.list","filter":?}` 列出',
            '- `{"action":"schedule.add","title":"...","start":"YYYY-MM-DD HH:mm","end":?,"note":?}`',
            '- `{"action":"schedule.view","startDate":?,"endDate":?}` 区间查看',
            '所有字段均可省，省 start 默认今天。',
        ].join('\n'),
        todo: [
            '## memo.todo — 待办',
            '- `{"action":"todo.list"}` / `{"action":"todo.view"}`',
            '- `{"action":"todo.add","title":"...","priority":?}`',
            '- `{"action":"todo.done","id":?}` / `{"action":"todo.delete","id":?}`',
        ].join('\n'),
        notes: [
            '## memo.notes — 笔记',
            '- `{"action":"notes.list"}`',
            '- `{"action":"notes.read","name":"..."}`',
            '- `{"action":"notes.write","name":"...","text":"..."}`',
            '- `{"action":"notes.delete","name":"..."}`',
        ].join('\n'),
        tasks: [
            '## memo.tasks — 定时任务',
            '- `{"action":"tasks.list"}`',
            '- `{"action":"tasks.trigger","id":?}` 立即执行',
        ].join('\n'),
        inbox: [
            '## memo.inbox — 收件箱',
            '- `{"action":"inbox.list"}`',
            '- `{"action":"inbox.read","id":?}` 标已读',
            '- `{"action":"inbox.clear"}`',
        ].join('\n'),
    };

    // 关键词 → 段名映射；命中即披露对应段
    const KEYWORD_MAP = {
        long: ['长期', '长记忆', '长期记忆', 'long memory', '永久记忆', '记住'],
        schedule: ['日程', '安排', '提醒', 'schedule', 'calendar', '会议', '约', '日历'],
        todo: ['待办', '任务清单', 'todo', 'task list', '事项', 'checklist'],
        notes: ['笔记', '便签', 'note ', 'notes'],
        tasks: ['定时任务', '定时', 'cron', '周期任务'],
        inbox: ['收件箱', 'inbox', '通知列表', '提醒列表'],
    };

    function computeFullSpec(ctx) {
        const text = String((ctx && ctx.userMsg) || '').toLowerCase();
        const sections = [];
        // 核心 month-append 始终注入
        sections.push([
            '## memo — 记忆与日程',
            '本月记忆（默认入口，写在这里）：',
            '- `{"action":"memory.month.append","text":"..."}` 追加到本月（自动归档当月文件）',
            '- `{"action":"memory.month.read"}` 读取本月全文',
            '其他能力（长期/日程/待办/笔记/任务/收件箱）按关键词披露——若未自动出现，直接调用同样可用，参数缺失会自动给默认。',
        ].join('\n'));
        for (const [key, kws] of Object.entries(KEYWORD_MAP)) {
            if (kws.some(kw => text.includes(kw.toLowerCase()))) {
                sections.push(SECTIONS[key]);
            }
        }
        return sections.join('\n\n');
    }

    const manifest = {
        id: 'memo',
        version: '1.0.0',
        tier: 1,
        title: '记忆与日程',
        icon: 'calendar-check',
        color: '#f59e0b',
        fences: ['memo'],
        nativeOnly: true,

        // 普通字段：保留一份基础 fullSpec 兜底
        fullSpec: [
            '## memo — 记忆与日程（基础）',
            '本月记忆：`{"action":"memory.month.append","text":"..."}`',
            '更多能力请提及"长期/日程/待办/笔记/任务/收件箱"以披露详细命令。',
        ].join('\n'),

        // 自定义动态披露（ContextComposer 优先调用）
        computeFullSpec,

        coreDescription: [
            '```memo',
            '{ "action": "memory.month.append", "text": "..." }',
            '```',
            '→ 记忆本月事项；提到「长期/日程/待办/笔记」会披露更多动作。',
            '兼容写法（自动归一）：`add` / `save` / `store` / `create` → `memory.month.append`；`get` / `list` / `show` → `memory.month.read`。',
            '只给 `text` 不给 `action` 时默认 `memory.month.append`。',
        ].join('\n'),

        intentKeywords: ['记忆', 'memo', '记住', '记下', '长期', '日程', '待办', '笔记', '收件箱', '定时任务'],

        intentConfig: {
            keywords: ['记忆', 'memo', '记住', '记下', '本月', '长期', '日程', 'schedule', '待办', 'todo', '笔记', 'note', '收件箱', 'inbox', '定时'],
            contextHints: {},
            baseScore: 1.0,
        },

        toolSchema: {
            name: 'memo',
            description: '记忆与日程：memory.month.append 默认；长期/日程/待办/笔记/任务/收件箱按需',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string' },
                    section: { type: 'string' },
                    text: { type: 'string' },
                    name: { type: 'string' },
                    title: { type: 'string' },
                    start: { type: 'string' },
                    end: { type: 'string' },
                    note: { type: 'string' },
                    id: {},
                    filter: {},
                    priority: { type: 'string' },
                    startDate: { type: 'string' },
                    endDate: { type: 'string' },
                },
            },
        },
    };

    if (global.AgentV2 && global.AgentV2.registerManifest) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
