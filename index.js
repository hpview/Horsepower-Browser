/**
 * AgentV2 — Engine 主入口
 *
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  概览：本文件是 V2 引擎的总装入口                          ║
 * ║  - §1 引擎配置（feature flags / 默认值）                   ║
 * ║  - §2 公共 API（创建引擎、运行一轮、状态查询）            ║
 * ║  - §3 单例与挂载（window.AgentV2.engine / boot()）         ║
 * ║  - §4 函数实现（buildEngine、runTurn、…）                  ║
 * ║                                                           ║
 * ║  ▶ 总分原则：前 200 行只放配置/主流程/类签名               ║
 * ║  ▶ 详细函数体在 §4 之后                                    ║
 * ║  ▶ 子模块：registry / invocation-parser / intent-detector  ║
 * ║              / context-composer / dispatcher / compressor  ║
 * ║  ▶ 兼容性：通过 v1Bridge 桥接旧 SkillManager               ║
 * ╚═══════════════════════════════════════════════════════════╝
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 配置 / 默认值
     * ════════════════════════════════════════════════════════════ */
    const DEFAULTS = {
        // settings.agent_engine = 'v1' | 'v2'，默认 v1（不破坏现有用户）
        engine: 'v1',
        // 自动加载的核心 manifest（按文件名）
        coreManifests: ['create', 'edit', 'file', 'sh'],
        // Tier-2 触发披露最大数
        maxDisclose: 2,
        // 是否启用结果压缩
        enableCompression: true,
    };

    /* ════════════════════════════════════════════════════════════
     *  §2 公共 API
     * ════════════════════════════════════════════════════════════ */
    /**
     * 创建一个 V2 引擎实例
     * @param {object} deps
     * @param {object} [deps.skillManager] - V1 SkillManager（用于 dispatch 桥接）
     * @param {object} [deps.config]
     * @returns {V2Engine}
     */
    function createEngine(deps = {}) { return _build(deps); }

    /**
     * 引擎类（轻量门面，组合所有子模块）
     */
    class V2Engine {
        constructor({ registry, parser, intentDetector, composer, dispatcher, compressor, nativeExecutor, skillManager, config }) {
            this.registry = registry;
            this.parser = parser;
            this.intentDetector = intentDetector;
            this.composer = composer;
            this.dispatcher = dispatcher;
            this.compressor = compressor;
            this.nativeExecutor = nativeExecutor || null;
            this.skillManager = skillManager;
            this.config = { ...DEFAULTS, ...(config || {}) };
        }

        /** 注册（额外）manifest */
        registerManifest(m) { this.registry.register(m); }

        /**
         * 一轮完整流程：构建系统提示 → （由调用者）取得 LLM 输出 →
         * 解析 invocations → 派发执行 → 压缩结果
         *
         * 通常分两步使用：
         *   1) buildSystemPrompt({ userMsg, env, llmHint, failedManifests })
         *   2) handleLLMResponse(text)  → { invocations, results, compressedResults }
         *
         * 目的：让外部（Electron 主流程或 sandbox HTML）自由插入 LLM 调用
         */
        buildSystemPrompt(input) {
            const r = this.composer.compose(input);
            // 同时附上 OpenAI 风格 tools（用于 tool-calling 模型）
            r.tools = this.getTools(r.debug?.disclosedIds, input);
            return r;
        }

        /**
         * 收集 manifest 的 OpenAI tool schema
         * @param {string[]} [disclosedIds] - 当前披露的 manifest id；不传则返回全部 Tier-0
         */
        getTools(disclosedIds, input = {}) {
            const all = this.registry.all ? this.registry.all() : [];
            const ids = disclosedIds && disclosedIds.length
                ? new Set([...this.config.coreManifests, ...disclosedIds])
                : new Set(this.config.coreManifests);
            return all
                .filter(m => m.toolSchema && (ids.has(m.id) || m.tier === 0) && this.isToolEnabled(m.id, input, m))
                .map(m => ({ type: 'function', function: m.toolSchema }));
        }

        getManifestMode(manifestId, input = {}, manifest = null) {
            let mode = 'immediate';
            try {
                const resolver = input.getManifestMode || input.manifestModeOf;
                if (typeof resolver === 'function') mode = resolver(manifestId, manifest || this.registry.get(manifestId)) || mode;
                else if (this.skillManager?.getSkillMode) mode = this.skillManager.getSkillMode(`v2:${manifestId}`);
            } catch (_) { /* ignore */ }
            if (mode === 'auto') return 'immediate';
            return ['immediate', 'after-turn', 'manual', 'disabled'].includes(mode) ? mode : 'immediate';
        }

        isToolEnabled(manifestId, input = {}, manifest = null) {
            return this.getManifestMode(manifestId, input, manifest) === 'immediate';
        }

        /** 标准化输入（fence text 或 tool_calls）→ invocations */
        normalize(input) { return this.parser.normalize ? this.parser.normalize(input) : this.parser.parse(input?.text || ''); }

        /** 解析 LLM 回复 */
        parse(text) { return this.parser.parse(text); }

        /** 派发并执行 */
        async runInvocations(invocations) { return this.dispatcher.dispatchAll(invocations); }

        /** 压缩结果（fresh / archive） */
        compressResult(manifestId, result, stage = 'fresh') {
            if (!this.config.enableCompression) return result;
            return this.compressor.compress(manifestId, result, { stage });
        }

        /**
         * end-to-end：给定 LLM 文本，自动 parse → execute → compress
         * @returns {Promise<{invocations, results, compressedResults}>}
         */
        async handleLLMResponse(text) { return _handleLLMResponse(this, text); }

        /** 状态摘要（调试用） */
        stats() {
            return {
                engine: this.config.engine,
                registry: this.registry.stats(),
                config: this.config,
            };
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 单例 boot
     * ════════════════════════════════════════════════════════════ */
    /**
     * 在 Electron 渲染进程中调用一次：自动从 window.skillManager 桥接
     * @param {object} [overrides] - 可覆盖 config
     * @returns {V2Engine}
     */
    function boot(overrides = {}) {
        if (global.AgentV2 && global.AgentV2.engine) return global.AgentV2.engine;
        const engine = createEngine({
            skillManager: global.skillManager,
            config: overrides,
        });
        global.AgentV2 = global.AgentV2 || {};
        global.AgentV2.engine = engine;
        return engine;
    }

    /* ════════════════════════════════════════════════════════════
     *  §4 函数实现
     * ════════════════════════════════════════════════════════════ */
    function _build({ skillManager, config }) {
        const ns = global.AgentV2 || {};
        const Registry = ns.V2Registry;
        const Parser = ns.InvocationParser;
        const IntentD = ns.IntentDetector;
        const Composer = ns.ContextComposer;
        const Dispatcher = ns.V2Dispatcher;
        const Compressor = ns.ResultCompressor;
        const NativeExec = ns.NativeExecutor;
        if (!Registry || !Parser || !IntentD || !Composer || !Dispatcher || !Compressor) {
            throw new Error('[AgentV2] 子模块未全部加载，请先按顺序引入 registry/invocation-parser/intent-detector/context-composer/dispatcher/result-compressor');
        }
        const registry = new Registry();
        const intentDetector = new IntentD(registry);
        const composer = new Composer({ registry, intentDetector });
        const nativeExecutor = NativeExec ? new NativeExec({ electronAPI: global.electronAPI }) : null;
        const dispatcher = new Dispatcher({ registry, skillManager, nativeExecutor });
        const compressor = new Compressor();
        return new V2Engine({
            registry,
            parser: new Parser(registry),
            intentDetector,
            composer,
            dispatcher,
            compressor,
            nativeExecutor,
            skillManager,
            config,
        });
    }

    async function _handleLLMResponse(engine, text) {
        const invocations = engine.parse(text);
        const results = await engine.runInvocations(invocations);
        const failedIds = [];
        const compressedResults = results.map((r, i) => {
            const id = invocations[i]?.manifestId;
            if (!r.success) failedIds.push(id);
            return engine.compressResult(id, r, 'fresh');
        });
        // 把失败标记给 composer，下轮强制保留 spec
        if (failedIds.length > 0) engine.composer.markFailed(failedIds);
        engine.composer.tick();
        // ── 任务终止信号 ──
        // 任意 invocation 携带 done/final/deliver/finalize:true，或 fence === 'finalize'
        // → 标记 taskComplete=true，外层不再续接对话
        const taskComplete = invocations.some(inv => {
            if (inv.fence === 'finalize') return true;
            const a = inv.args || {};
            return a.done === true || a.final === true || a.finalize === true || a.deliver === true || a.taskComplete === true;
        });
        return { invocations, results, compressedResults, failedIds, taskComplete };
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { createEngine, boot, V2Engine, DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
        // 在 boot 前临时把 registerManifest 接到暂存数组
        // boot.js 启动 engine 时会回放并改写这个引用
        if (!global.AgentV2._pendingManifests) {
            global.AgentV2._pendingManifests = [];
            global.AgentV2.registerManifest = (m) => global.AgentV2._pendingManifests.push(m);
        }
    }
})(typeof window !== 'undefined' ? window : globalThis);
