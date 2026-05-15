/**
 * AgentV2 — IntentDetector v2
 *
 * 多源综合 + 评分披露
 *
 * 输入信号：
 *   1. 用户消息（关键词命中）
 *   2. 当前编辑器状态（已打开文件类型）
 *   3. 当前浏览器/标签页（url/tab kind）
 *   4. 历史调用（最近用过加权）
 *   5. 错误标记（上轮失败强制 fullSpec 披露）
 *
 * 输出：
 *   { disclosures: [{ id, score, level: 'full'|'core'|'oneline' }], scoreMap, ids }
 *
 * 文件结构：
 *   §1 默认权重 / 阈值
 *   §2 主入口 IntentDetector
 *   §3 评分函数
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 默认配置
     * ════════════════════════════════════════════════════════════ */
    const DEFAULTS = {
        weights: {
            keywordHit: 0.4,        // 每个关键词命中
            editor: 0.3,        // 编辑器扩展名匹配
            browser: 0.3,        // 当前 url 命中 contextHints.browser
            tabs: 0.2,        // 当前标签页类型
            retry: 0.5,        // 上轮失败强制重披露
            recent: 0.2,        // 最近调用过
            tier: -0.4,       // tier 越高越克制（×tier）
        },
        thresholds: {
            full: 2.0,
            core: 1.0,
            oneline: 0.5,
        },
        maxDisclose: 3,
        excludeTier0: true,         // Tier-0 不参与披露（常驻）
    };

    /* ════════════════════════════════════════════════════════════
     *  §2 主入口
     * ════════════════════════════════════════════════════════════ */
    class IntentDetector {
        constructor(registry, config) {
            this.registry = registry;
            this.config = _mergeConfig(DEFAULTS, config);
        }

        configure(partial) { this.config = _mergeConfig(this.config, partial); }

        /**
         * 兼容旧签名 detect(userMsg, llmHint) 与新签名 detect(ctx)
         * @param {string|object} arg1
         *   - 字符串：userMsg
         *   - 对象 ctx: { userMsg, llmHint, env, editor, browser, tabs, recentManifestIds, failedManifestIds }
         * @returns {{ ids: string[], scores: Map<string, number>, disclosures: Array<{id,score,level}> }}
         */
        detect(arg1, llmHint) {
            const ctx = typeof arg1 === 'string' ? { userMsg: arg1, llmHint } : (arg1 || {});
            return _detect(this, ctx);
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 实现
     * ════════════════════════════════════════════════════════════ */
    function _detect(self, ctx) {
        const w = self.config.weights;
        const text = `${ctx.userMsg || ''}\n${ctx.llmHint || ''}`.toLowerCase();
        const editorPath = ctx.editor?.openFile || ctx.editor?.path || '';
        const editorExt = _extOf(editorPath);
        const browserUrl = (ctx.browser?.url || '').toLowerCase();
        const _activeTab = ctx.tabs?.active;
        const tabKind = (
            (typeof _activeTab === 'string' ? _activeTab : '') ||
            (_activeTab && typeof _activeTab === 'object' ? (_activeTab.type || _activeTab.kind || '') : '') ||
            (typeof ctx.tabs?.kind === 'string' ? ctx.tabs.kind : '') ||
            ''
        ).toString().toLowerCase();
        const recentSet = new Set(ctx.recentManifestIds || []);
        const failedSet = new Set(ctx.failedManifestIds || []);

        const scores = new Map();
        const detail = new Map();

        for (const m of self.registry.all()) {
            const tier = m.tier ?? 1;
            if (self.config.excludeTier0 && tier === 0) continue;

            const cfg = m.intentConfig || {};
            const keywords = cfg.keywords || m.intentKeywords || [];
            const hints = cfg.contextHints || {};
            const baseScore = typeof cfg.baseScore === 'number' ? cfg.baseScore : 0;

            // 关键词命中
            let kwHits = 0;
            for (const kw of keywords) {
                if (text.includes(String(kw).toLowerCase())) kwHits++;
            }

            const editorMatch = (hints.editor || []).some(ext => editorExt && (editorExt === ext || editorPath.toLowerCase().endsWith(ext)));
            const browserMatch = (hints.browser || []).some(p => browserUrl.includes(String(p).toLowerCase()));
            const tabsMatch = (hints.tabs || []).some(t => tabKind.includes(String(t).toLowerCase()));
            const retry = failedSet.has(m.id);
            const recent = recentSet.has(m.id);

            const score
                = baseScore
                + kwHits * w.keywordHit
                + (editorMatch ? w.editor : 0)
                + (browserMatch ? w.browser : 0)
                + (tabsMatch ? w.tabs : 0)
                + (retry ? w.retry : 0)
                + (recent ? w.recent : 0)
                + tier * w.tier;

            if (score > 0) {
                scores.set(m.id, score);
                detail.set(m.id, { kwHits, editorMatch, browserMatch, tabsMatch, retry, recent, tier });
            }
        }

        const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, self.config.maxDisclose);
        const t = self.config.thresholds;
        const disclosures = sorted
            .map(([id, score]) => {
                let level = null;
                if (score >= t.full) level = 'full';
                else if (score >= t.core) level = 'core';
                else if (score >= t.oneline) level = 'oneline';
                return level ? { id, score: +score.toFixed(3), level, detail: detail.get(id) } : null;
            })
            .filter(Boolean);

        return { ids: disclosures.map(d => d.id), scores, disclosures };
    }

    function _extOf(p) {
        if (!p) return '';
        const m = String(p).match(/\.([a-z0-9]+)(?:\s|$|\?)/i);
        return m ? '.' + m[1].toLowerCase() : '';
    }

    function _mergeConfig(base, patch) {
        if (!patch) return { ...base, weights: { ...base.weights }, thresholds: { ...base.thresholds } };
        return {
            ...base,
            ...patch,
            weights: { ...base.weights, ...(patch.weights || {}) },
            thresholds: { ...base.thresholds, ...(patch.thresholds || {}) },
        };
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { IntentDetector };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
