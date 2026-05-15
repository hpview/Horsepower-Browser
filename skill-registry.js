/**
 * Phase D · SkillRegistry（renderer 单例）
 *
 * 职责：
 *   - 启动时从主进程 IPC 拉取持久化 skill 列表（仅 metadata）
 *   - 内存维护 user / mcp / builtin 三类 skill
 *   - 提供 list() / get(id) / save() / delete() 的统一 renderer 接口
 *   - 提供 lookup(idOrName) 给 ScriptRuntime / context-composer
 *
 * 注：完整 code 仅在调用时按需 IPC 拉取（避免一次性把所有脚本载入 renderer 内存）。
 */

(function (global) {
    'use strict';

    class SkillRegistry {
        constructor() {
            this._cache = new Map(); // id → 列表项 metadata（不含 code）
            this._loaded = false;
            this._listeners = new Set();
        }

        async load() {
            const api = global.electronAPI?.skills;
            if (!api) {
                this._loaded = true;
                return [];
            }
            try {
                const items = await api.list();
                this._cache.clear();
                for (const it of (items || [])) this._cache.set(it.id, it);
                this._loaded = true;
                this._emit('loaded');
                return items || [];
            } catch (e) {
                console.warn('[SkillRegistry] load failed:', e?.message);
                this._loaded = true;
                return [];
            }
        }

        list({ kind } = {}) {
            const all = Array.from(this._cache.values());
            if (kind) return all.filter(s => s.kind === kind);
            return all;
        }

        getMeta(id) { return this._cache.get(id) || null; }

        async getFull(id) {
            const api = global.electronAPI?.skills;
            if (!api) return null;
            try { return await api.get(id); }
            catch { return null; }
        }

        /** 模糊查找：按 id 完全匹配 → name 包含 → tags 包含 */
        lookup(query) {
            if (!query) return null;
            const q = String(query).toLowerCase();
            // 先 id 完全匹配
            if (this._cache.has(query)) return this._cache.get(query);
            // name 包含
            for (const s of this._cache.values()) {
                if (s.name && s.name.toLowerCase().includes(q)) return s;
            }
            // tags 命中
            for (const s of this._cache.values()) {
                if ((s.tags || []).some(t => t.toLowerCase().includes(q))) return s;
            }
            return null;
        }

        /**
         * 持久化保存
         * @param {object} skill 完整 skill manifest（带 scripts[].code）
         */
        async save(skill) {
            const api = global.electronAPI?.skills;
            if (!api) return { ok: false, error: 'skills API 不可用' };
            const r = await api.save(skill);
            if (r?.ok) {
                await this.load(); // 刷新 cache
                this._emit('changed', skill.id);
            }
            return r;
        }

        async delete(id) {
            const api = global.electronAPI?.skills;
            if (!api) return { ok: false, error: 'skills API 不可用' };
            const r = await api.delete(id);
            if (r?.ok) {
                this._cache.delete(id);
                this._emit('changed', id);
            }
            return r;
        }

        /** 解析 "skillId.scriptName" → { skill, script, codeText } */
        async resolveScript(qualifiedName) {
            const m = String(qualifiedName || '').match(/^([^.]+)\.(.+)$/);
            if (!m) return { error: `script name 格式应为 "skillId.scriptName"` };
            const [, skillId, scriptName] = m;
            const skill = await this.getFull(skillId);
            if (!skill) return { error: `skill "${skillId}" 不存在` };
            const script = (skill.scripts || []).find(s => s.name === scriptName);
            if (!script) return { error: `skill "${skillId}" 没有脚本 "${scriptName}"` };
            if (script._mcpTool) return { skill, script, mcp: script._mcpTool };
            if (!script.code) return { error: `script "${qualifiedName}" 无 code（纯文本说明类不可执行）` };
            return { skill, script, codeText: script.code };
        }

        on(event, cb) { this._listeners.add({ event, cb }); }
        off(cb) { for (const l of this._listeners) if (l.cb === cb) this._listeners.delete(l); }
        _emit(event, ...args) {
            for (const l of this._listeners) if (l.event === event) {
                try { l.cb(...args); } catch (_) { /* ignore */ }
            }
        }
    }

    const skillRegistry = new SkillRegistry();
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        global.AgentV2.SkillRegistry = SkillRegistry;
        global.AgentV2.skillRegistry = skillRegistry;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { SkillRegistry, skillRegistry };
})(typeof window !== 'undefined' ? window : globalThis);
