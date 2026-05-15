/**
 * AgentV2 — ResultCompressor
 *
 * 职责：对长上下文结果（搜索/网页正文/大文件）做两级压缩
 *   - 当轮：截断到 ~2000 字符（足够 AI 理解）
 *   - N 轮后：进一步压到 ~200 字符摘要（保留关键字段）
 *
 * 设计要点：
 *   - 按 manifestId 注册压缩函数，未注册则保留原状
 *   - 与 V1 _compressOldSkillResults 互补：V1 处理结构化字段，本模块处理原始大文本
 *
 * 文件结构：
 *   §1 配置
 *   §2 主入口
 *   §3 注册 + 内置压缩函数
 */
(function (global) {
    'use strict';

    /* ════════════════════════════════════════════════════════════
     *  §1 配置
     * ════════════════════════════════════════════════════════════ */
    const FIRST_TURN_LIMIT = 2000;  // 当轮裁切
    const ARCHIVE_LIMIT = 200;       // N 轮后摘要

    /* ════════════════════════════════════════════════════════════
     *  §2 主入口
     * ════════════════════════════════════════════════════════════ */
    class ResultCompressor {
        constructor() {
            /** @type {Map<string, Function>} */
            this._handlers = new Map();
            _registerBuiltin(this);
        }

        register(manifestId, fn) { this._handlers.set(manifestId, fn); }

        /**
         * @param {string} manifestId
         * @param {any} result
         * @param {object} ctx { stage: 'fresh'|'archive', userQuery?: string }
         */
        compress(manifestId, result, ctx = { stage: 'fresh' }) {
            const fn = this._handlers.get(manifestId) || _defaultCompressor;
            try { return fn(result, ctx); } catch { return result; }
        }
    }

    /* ════════════════════════════════════════════════════════════
     *  §3 内置 + 默认压缩函数
     * ════════════════════════════════════════════════════════════ */
    function _registerBuiltin(self) {
        // browser/file/sh 的搜索/读取通用压缩
        self.register('file', (r, ctx) => _truncateText(r, ctx, ['content', 'matches']));
        self.register('sh', (r, ctx) => _truncateText(r, ctx, ['stdout', 'stderr', 'output']));
        // browser 由旧 V1 桥接，按 'browser' 注册（即便没在 V2 manifest 中）
        self.register('browser', (r, ctx) => _truncateText(r, ctx, ['content', 'fullText', 'results']));
    }

    function _defaultCompressor(r, ctx) {
        if (typeof r === 'string') return _clip(r, ctx);
        return r;
    }

    function _truncateText(r, ctx, fields) {
        if (!r || typeof r !== 'object') return r;
        const limit = ctx.stage === 'archive' ? ARCHIVE_LIMIT : FIRST_TURN_LIMIT;
        const cloned = { ...r };
        for (const f of fields) {
            const v = cloned[f];
            if (typeof v === 'string' && v.length > limit) {
                cloned[f] = v.slice(0, limit) + `\n…[truncated ${v.length - limit} chars]`;
            } else if (Array.isArray(v)) {
                // 仅当元素是字符串/对象时压缩
                cloned[f] = v.slice(0, ctx.stage === 'archive' ? 3 : 10);
            }
        }
        return cloned;
    }

    function _clip(s, ctx) {
        const limit = ctx.stage === 'archive' ? ARCHIVE_LIMIT : FIRST_TURN_LIMIT;
        if (s.length <= limit) return s;
        return s.slice(0, limit) + `\n…[truncated ${s.length - limit} chars]`;
    }

    /* ════════════════════════════════════════════════════════════
     *  导出
     * ════════════════════════════════════════════════════════════ */
    const exports_ = { ResultCompressor };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
