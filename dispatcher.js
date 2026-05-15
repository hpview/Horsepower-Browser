/**
 * AgentV2 — Dispatcher
 *
 * 职责：将 V2 invocation 转发给 V1 SkillManager 执行（保持向后兼容）
 *
 * 设计：
 *   - 通过 manifest.v1Bridge 字段映射到旧 skillId + codeBlockLang
 *   - V1 各 skill 的 parseCodeBlock + execute 全部复用，不重写
 *   - 后续 V2 可逐步把执行体迁出 SkillManager，但 Phase A 保持桥接
 *
 * 文件结构：
 *   §1 配置
 *   §2 主入口 dispatch()
 *   §3 实现
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 配置
     * ════════════════════════════════════════════════════════════ */
    // 暂无

    /* ════════════════════════════════════════════════════════════
     *  §2 主入口
     * ════════════════════════════════════════════════════════════ */
    class V2Dispatcher {
        /**
         * @param {object} deps
         * @param {V2Registry} deps.registry
         * @param {object} [deps.skillManager] - V1 SkillManager（可选 fallback）
         * @param {NativeExecutor} [deps.nativeExecutor] - 优先用，且独立于 V1
         */
        constructor({ registry, skillManager, nativeExecutor }) {
            this.registry = registry;
            this.skillManager = skillManager;
            this.nativeExecutor = nativeExecutor;
        }

        /**
         * 把 V2 invocation 转换为 V1 风格 block，交给 V1 执行
         * @param {{manifestId, args, raw}} invocation
         * @returns {Promise<{success:boolean, result?:any, error?:string}>}
         */
        async dispatch(invocation) { return _dispatch(this, invocation); }

        /**
         * 把多条 invocation 顺序执行
         * @param {Array} invocations
         * @returns {Promise<Array>}
         */
        async dispatchAll(invocations) {
            invocations = _normalizeBatchInvocations(this, invocations);
            const results = [];
            for (const inv of invocations) {
                results.push(await this.dispatch(inv));
            }
            return results;
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 实现
     * ════════════════════════════════════════════════════════════ */
    async function _dispatch(self, invocation) {
        const m = self.registry.get(invocation.manifestId);
        if (!m) return { success: false, error: `unknown manifest: ${invocation.manifestId}` };

        if (invocation.parseError) {
            return { success: false, error: `JSON parse error: ${invocation.parseError}` };
        }

        const mode = _getInvocationMode(self, invocation, m);
        if (mode === 'disabled') {
            return { success: false, error: `skill disabled: ${m.id}` };
        }
        if ((mode === 'manual' || mode === 'after-turn') && !_isUiSource(invocation.source)) {
            return { success: false, error: `${m.id}: ${mode} confirmation required` };
        }

        // ── 优先 native ──
        if (self.nativeExecutor && self.nativeExecutor.canHandle(m.id)) {
            // search/read 语法糖：fence 名直接强制 mode（grep/web/files → search.mode）
            let args = invocation.args;
            // 数组形式（多步）跳过 mode 注入；NativeExecutor 会逐步分发
            const isList = Array.isArray(args);
            if (!isList && m.id === 'search' && invocation.fence) {
                const f = String(invocation.fence).toLowerCase();
                if (f === 'grep' || f === 'web' || f === 'files') {
                    args = Object.assign({}, args, { mode: f });
                }
            }
            if (!isList && m.id === 'read' && invocation.fence) {
                const f = String(invocation.fence).toLowerCase();
                // 语法糖：page/tab/abstract/file-read 直接锁 mode
                const sugarMap = { 'page': 'page', 'tab': 'tab', 'abstract': 'abstract', 'file-read': 'file', 'page-read': 'page', 'tab-read': 'tab' };
                if (sugarMap[f]) {
                    args = Object.assign({}, args, { mode: sugarMap[f] });
                }
            }
            const r = await self.nativeExecutor.execute(m.id, args);
            // native 失败且有 v1Bridge 时回退到 V1（除非 nativeOnly：禁止退回 HTML/V1 路径）
            if (r && r.success === false && m.v1Bridge && !m.nativeOnly && self.skillManager) {
                console.warn('[V2Dispatcher] native failed, falling back to V1:', r.error);
                // 继续走下面 V1 分支
            } else {
                return r;
            }
        }

        // ── manifest 自带 execute（Phase D：script 等独立 manifest 用）──
        if (typeof m.execute === 'function') {
            try {
                const r = await m.execute(invocation.args, { registry: self.registry, dispatcher: self });
                if (r && typeof r.success === 'boolean') return r;
                return { success: true, result: r };
            } catch (e) {
                return { success: false, error: e?.message || String(e) };
            }
        }

        // native 不支持或仅 native 但没注入 → 直接 V1
        if (m.nativeOnly && !self.nativeExecutor) {
            return { success: false, error: `${m.id}: nativeOnly but no NativeExecutor injected` };
        }

        const bridge = m.v1Bridge;
        if (!bridge) return { success: false, error: `manifest ${m.id} has no v1Bridge and native not available` };

        const sm = self.skillManager;
        if (!sm) return { success: false, error: 'V1 SkillManager not available' };

        const skill = sm.getSkill ? sm.getSkill(bridge.skillId) : sm._skills?.get(bridge.skillId);
        if (!skill) return { success: false, error: `V1 skill not registered: ${bridge.skillId}` };

        // 用 V1 skill 的 parseCodeBlock（如有）规范化 args
        let action = invocation.args;
        try {
            if (skill.parseCodeBlock) {
                action = skill.parseCodeBlock(JSON.stringify(invocation.args), bridge.codeBlockLang);
            }
        } catch (e) {
            return { success: false, error: `parse error in V1 bridge: ${e.message}` };
        }

        // 调用 V1 execute（不同 skill 接口名差异：execute / executeAction / run）
        try {
            let result;
            if (typeof skill.execute === 'function') {
                result = await skill.execute(action);
            } else if (typeof skill.executeAction === 'function') {
                result = await skill.executeAction(action);
            } else if (typeof skill.run === 'function') {
                result = await skill.run(action);
            } else {
                return { success: false, error: `V1 skill ${bridge.skillId} has no execute/run method` };
            }
            // V1 返回值可能直接是结果或 {success, ...}
            if (result && typeof result.success === 'boolean') return result;
            return { success: true, result };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    function _normalizeBatchInvocations(self, invocations) {
        const adapter = self.nativeExecutor?._editAdapter;
        if (!adapter || typeof adapter.normalizeBatchInvocations !== 'function') return invocations;
        try {
            return adapter.normalizeBatchInvocations(invocations);
        } catch (error) {
            console.warn('[V2Dispatcher] normalizeBatchInvocations failed:', error?.message || error);
            return invocations;
        }
    }

    function _getInvocationMode(self, invocation, manifest) {
        const sm = self.skillManager || global.skillManager;
        if (!sm || !manifest?.id) return 'immediate';
        const valid = ['immediate', 'after-turn', 'manual', 'disabled'];
        let mode = null;
        try {
            const v2SkillId = `v2:${manifest.id}`;
            if (sm._skillModes?.has?.(v2SkillId)) mode = sm.getSkillMode(v2SkillId);
            const legacyId = manifest.v1Bridge?.skillId;
            if (!mode && legacyId && sm._skillModes?.has?.(legacyId)) mode = sm.getSkillMode(legacyId);
            if (!mode && sm.getSkill?.(v2SkillId)) mode = sm.getSkillMode(v2SkillId);
        } catch (_) { /* ignore */ }
        if (mode === 'auto') mode = 'immediate';
        return valid.includes(mode) ? mode : 'immediate';
    }

    function _isUiSource(source) {
        return source === 'ui' || source === 'manual';
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { V2Dispatcher };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
