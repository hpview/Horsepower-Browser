/**
 * AgentV2 — Registry
 *
 * 职责：管理 manifest 注册、fence 名 → manifest 反查、按 tier 分组
 *
 * 文件结构：
 *   §1 配置/常量
 *   §2 类定义（构造、主入口）
 *   §3 函数实现
 */

(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 配置 / 常量
     * ════════════════════════════════════════════════════════════ */
    const TIER = {
        CORE: 0,    // 始终常驻 (create/edit/file/sh)
        META: 1,    // 元信息（一行 summary）
        DISCLOSED: 2, // 触发披露
        ON_DEMAND: 3, // 按需
    };

    /* ════════════════════════════════════════════════════════════
     *  §2 Registry 类
     * ════════════════════════════════════════════════════════════ */
    class V2Registry {
        constructor() {
            /** @type {Map<string, object>} id → manifest */
            this._byId = new Map();
            /** @type {Map<string, string>} fence → id */
            this._fenceIndex = new Map();
        }

        /** 注册 manifest */
        register(manifest) { return _register(this, manifest); }

        /** 通过 id 取 manifest */
        get(id) { return this._byId.get(id); }

        /** 通过 fence 名查 id（O(1)） */
        idByFence(fence) { return this._fenceIndex.get(fence); }

        /** 取某 tier 的全部 manifest */
        byTier(tier) { return _byTier(this, tier); }

        /** 取所有已注册 manifest */
        all() { return Array.from(this._byId.values()); }

        /** 统计信息（调试） */
        stats() {
            return {
                total: this._byId.size,
                fences: this._fenceIndex.size,
                byTier: {
                    0: this.byTier(0).length,
                    1: this.byTier(1).length,
                    2: this.byTier(2).length,
                    3: this.byTier(3).length,
                },
            };
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 函数实现
     * ════════════════════════════════════════════════════════════ */
    function _register(self, m) {
        if (!m || !m.id) throw new Error('[V2Registry] manifest missing id');
        self._byId.set(m.id, m);
        const fences = Array.isArray(m.fences) ? m.fences : [m.id];
        for (const f of fences) self._fenceIndex.set(f, m.id);
    }

    function _byTier(self, tier) {
        const out = [];
        for (const m of self._byId.values()) {
            if ((m.tier ?? 1) === tier) out.push(m);
        }
        return out;
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { V2Registry, TIER };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exports_;
    }
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
