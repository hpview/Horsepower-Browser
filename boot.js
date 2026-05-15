/**
 * AgentV2 — Boot
 *
 * 在 V2 引擎所有子模块 + manifest 加载完毕后启动单例
 * 通过 window.AgentV2.engine 暴露
 *
 * 注意：本文件必须最后加载（在所有 manifest 之后）
 */
(function () {
    'use strict';

    function bootEngine() {
        if (!window.AgentV2 || !window.AgentV2.createEngine) {
            console.warn('[AgentV2] 子模块未加载，跳过 boot');
            return;
        }
        // 此时 AgentV2.registerManifest 还是 index.js 里残留的全局桩
        // 我们需要：先 createEngine（registry 为空），然后注册路由到该 registry，再"重放"已加载 manifest
        // 但 manifest IIFE 已经执行过了：它们调用了 AgentV2.registerManifest(m)
        // 由于 createEngine 内部临时挂载又恢复，会丢失这些注册
        //
        // 更稳妥：在脚本顺序里 manifest 必须在 boot 之前加载，且 registerManifest 接到一个"暂存区"
        // index.js 的 registerManifest 默认是全局桩，我们改成：暂存到 _pendingManifests 数组

        // 读取暂存的 manifest（由 manifest IIFE push 进来）
        const pending = window.AgentV2._pendingManifests || [];

        const engine = window.AgentV2.createEngine({ skillManager: window.skillManager });
        for (const m of pending) engine.registerManifest(m);
        window.AgentV2.engine = engine;

        // 后续 registerManifest 直接走 engine.registry
        window.AgentV2.registerManifest = (m) => engine.registerManifest(m);

        console.log('[AgentV2] booted', engine.stats());

        // ── V1 桥接：把 V2 manifest 注册成 V1 风格 skill ──
        // 让现有 ai-chat.js 的代码块解析 / 折叠 UI / ReAct 自动循环对 V2 fence 生效
        try {
            if (window.AgentV2.bridgeAll && window.skillManager) {
                const n = window.AgentV2.bridgeAll({ skillManager: window.skillManager, engine });
                console.log(`[AgentV2] V1 bridge skills registered: ${n}`);
                try {
                    const chat = window.aiChatManager;
                    if (chat && typeof chat._setAgentMode === 'function') {
                        chat._setAgentMode(chat._agentMode || 'full', true);
                        chat._updateSkillsToggleUI?.();
                    }
                    window.dispatchEvent(new CustomEvent('agentv2:bridge-ready', { detail: { count: n } }));
                } catch (_) { /* ignore */ }
            }
        } catch (e) {
            console.warn('[AgentV2] V1 bridge failed:', e);
        }

        // ── Phase D：拉取持久化 skill 列表 ──
        try {
            if (window.AgentV2.skillRegistry?.load) {
                window.AgentV2.skillRegistry.load().then(items => {
                    console.log(`[AgentV2] SkillRegistry loaded: ${items?.length || 0} skill(s)`);
                }).catch(e => console.warn('[AgentV2] SkillRegistry load error:', e));
            }
        } catch (e) {
            console.warn('[AgentV2] SkillRegistry init failed:', e);
        }
    }

    // 等 V1 skillManager 准备好后启动
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(bootEngine, 50);
    } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(bootEngine, 50));
    }
})();
