/**
 * AgentV2 — V1 Skill Bridge
 *
 * 把 V2 manifest 注册成 V1 风格 skill，让现有 ai-chat.js UI/ReAct 循环原生支持 V2 fence。
 *
 * 注册模式：
 *   - id: `v2:<manifestId>`（避免与 V1 同名 skill 冲突）
 *   - codeBlockLang: manifest.fences（如 ['create', 'ai-create']）
 *   - parseCodeBlock: JSON.parse（fallback：用 invocation-parser 重新解析）
 *   - executeAction: 调用 V2 dispatcher
 *   - getToolDefinitions: 返回 ''（V2 提示词由 _buildSystemPrompt 统一构建）
 *
 * 这样 V1 ai-chat.js 的：
 *   - 代码块 → 折叠行 UI
 *   - immediate/after-turn 模式
 *   - executionLog
 *   - _feedSkillResultsToAI ReAct 循环
 * 全部对 V2 fence 自动生效。
 */
(function (global) {
    'use strict';

    /**
     * 历史兼容别名（ai-create / ai-editor / ai-file / ai-terminal）已弃用。
     * V2 仅注册新 fence，避免模型继续学习/回退到旧调用格式。
     */
    const V1_FENCE_ALIASES = {};

    /** V2 manifest id → 取代的 V1 skill id 列表（UI 隐藏被取代的 V1 skill，避免新旧混杂） */
    const V1_REPLACES = {
        create: ['editor'],   // V2 create 取代 EditorSkill 的 create 部分（edit 也由 editor 提供，所以 edit 单独不重复声明）
        edit: ['editor'],
        file: ['file'],
        sh: ['terminal'],
        browser: ['browser', 'web-actions'],
        memo: ['memo'],
        subagent: ['subagent'],
    };

    function bridgeAll({ skillManager, engine }) {
        if (!skillManager || !engine || !engine.registry) return 0;

        const manifests = engine.registry.all();
        let registered = 0;
        const replacedV1 = new Set();

        for (const m of manifests) {
            const skillId = `v2:${m.id}`;
            // 已注册则跳过
            if (skillManager.getSkill && skillManager.getSkill(skillId)) continue;

            const baseFences = Array.isArray(m.fences) && m.fences.length ? m.fences : [m.id];
            const v1Aliases = V1_FENCE_ALIASES[m.id] || [];
            const fences = [...new Set([...baseFences, ...v1Aliases])];
            const replacesV1 = V1_REPLACES[m.id] || [];
            for (const id of replacesV1) replacedV1.add(id);
            const skill = {
                name: m.title || m.id,
                icon: m.icon || 'zap',
                color: m.color || '#0ea5e9',
                codeBlockLang: fences,
                _v2ManifestId: m.id,
                _isV2Bridge: true,
                _replacesV1: replacesV1,

                /** UI 渲染时用：从代码块文本里解析出 action（V2 invocation.args） */
                parseCodeBlock(text /*, lang */) {
                    const t = String(text || '').trim();
                    if (!t) return {};
                    try { return JSON.parse(t); } catch (e) { /* fallthrough */ }
                    // 容错：尝试用 invocation-parser
                    try {
                        const parser = global.AgentV2 && global.AgentV2.engine && global.AgentV2.engine.parser;
                        if (parser) {
                            const arr = parser.parse('```' + fences[0] + '\n' + t + '\n```');
                            if (arr && arr[0] && !arr[0].parseError) return arr[0].args;
                        }
                    } catch (_) { /* ignore */ }
                    return null;
                },

                /** 执行：转发到 V2 dispatcher */
                async executeAction(action) {
                    const eng = global.AgentV2 && global.AgentV2.engine;
                    if (!eng || !eng.dispatcher) return { success: false, error: 'V2 engine not ready' };
                    const invocation = {
                        manifestId: m.id,
                        fence: fences[0],
                        args: action || {},
                        raw: '',
                        source: 'ui',
                    };
                    const r = await eng.dispatcher.dispatch(invocation);
                    // 终止信号：args 内 done/final/deliver/finalize:true → 写入全局 + 标记结果
                    let isFinalize = false;
                    try {
                        const a = action || {};
                        if (a.done === true || a.final === true || a.finalize === true || a.deliver === true || a.taskComplete === true || invocation.fence === 'finalize') {
                            isFinalize = true;
                            const chat = global.aiChatManager;
                            if (chat) chat._lastV2TaskComplete = true;
                            console.log('[AgentV2] taskComplete signal raised by', invocation.fence, '/', m.id);
                        }
                    } catch (_) { /* ignore */ }
                    const result = r || { success: false, error: 'no result' };
                    if (isFinalize) {
                        result.taskComplete = true;
                        result.summary = result.summary || '任务终止（finalize 信号）';
                    }
                    return result;
                },

                /** V2 系统提示词由 ai-chat 的 _buildSystemPrompt V2 分支统一管理；这里返回空 */
                getToolDefinitions() { return ''; },
            };

            skillManager.register(skillId, skill);
            registered++;
        }

        for (const oldId of replacedV1) {
            if (!oldId) continue;
            if (skillManager.getSkill && skillManager.getSkill(oldId)) {
                try {
                    skillManager.unregister(oldId);
                    console.log(`[AgentV2] unregistered replaced V1 skill: ${oldId}`);
                } catch (_) { /* ignore */ }
            }
        }

        return registered;
    }

    /** 把 V2 fence 也加进 ai-chat.js 的 hiddenCodeLangs（折叠 UI） */
    function getV2HiddenLangs() {
        const eng = global.AgentV2 && global.AgentV2.engine;
        if (!eng || !eng.registry) return [];
        const out = new Set();
        for (const m of eng.registry.all()) {
            const fences = Array.isArray(m.fences) ? m.fences : [m.id];
            for (const f of fences) out.add(f);
        }
        return Array.from(out);
    }

    /** 收集 V2 桥取代的所有 V1 skill id，UI 据此隐藏（V2 已默认启用时） */
    function getReplacedV1Ids() {
        const eng = global.AgentV2 && global.AgentV2.engine;
        if (!eng || !eng.registry) return [];
        const out = new Set();
        for (const m of eng.registry.all()) {
            const arr = V1_REPLACES[m.id] || [];
            for (const id of arr) out.add(id);
        }
        return Array.from(out);
    }

    const exports_ = { bridgeAll, getV2HiddenLangs, getReplacedV1Ids };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
