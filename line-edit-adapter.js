/**
 * AgentV2 — LineEditAdapter
 *
 * edit manifest 的原生执行体（per-type 适配）：
 *   - 代码/文本文件 → CodeAdapter（按行操作 + IPC writeFile）
 *   - canvas-editor 文档 → DocumentAdapter（按段落操作 + viewer.applyTextPatches/setTextStream）
 *   - 其它 → V1BridgeAdapter（兜底退回 EditorSkill ai-editor 协议）
 *
 * 段 id：
 *   - viewer.getParagraphs() 返回的 id 是 viewer 实例内持久稳定的（基于文本对齐迁移）
 *   - 调用方可写 from:"id:xyz" / from:"#xyz" 或纯数字段号
 *   - 数字段号在多 edit 中可能漂移，建议 AI 单回复内多 edit 用 id 锚定
 */
(function (global) {
    'use strict';

    // 解析 from/to 引用：支持数字、"id:xxx"、"#xxx"，以及裸 id（如 "p2", "pa"）
    // 返回该段落在 paragraphs 数组中的 0-based 下标，找不到返回 -1
    function _resolveParaRef(paragraphs, ref, fallback) {
        if (ref == null || ref === '') return fallback != null ? fallback : -1;
        if (typeof ref === 'number') return Math.max(0, ref - 1);
        const s = String(ref).trim();
        if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10) - 1);
        const idMatch = s.match(/^(?:id:|#)(.+)$/);
        if (idMatch) {
            const id = idMatch[1];
            const idx = paragraphs.findIndex(p => p.id === id);
            return idx; // -1 if not found
        }
        // 裸 id 容错：直接匹配段落 id
        const directIdx = paragraphs.findIndex(p => p.id === s);
        if (directIdx >= 0) return directIdx;
        const n = parseInt(s, 10);
        if (Number.isFinite(n)) return Math.max(0, n - 1);
        return -1;
    }

    function _normalizeEditType(type) {
        return String(type || '').toLowerCase().replace(/_/g, '-');
    }

    function _decodeHtmlEntities(text) {
        return String(text || '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'");
    }

    function _normalizeDocumentDisplayText(text) {
        const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
        if (!raw) return '';
        if (!/<\/?[a-z][^>]*>/i.test(raw)) {
            return raw.split('\n').map(s => s.trim()).filter(Boolean).join(' / ');
        }
        let normalized = raw;
        normalized = normalized.replace(/<br\s*\/?>/gi, '\n');
        normalized = normalized.replace(/<li\b[^>]*>/gi, '- ');
        normalized = normalized.replace(/<h1\b[^>]*>/gi, '# ');
        normalized = normalized.replace(/<h2\b[^>]*>/gi, '## ');
        normalized = normalized.replace(/<h3\b[^>]*>/gi, '### ');
        normalized = normalized.replace(/<h4\b[^>]*>/gi, '#### ');
        normalized = normalized.replace(/<h5\b[^>]*>/gi, '##### ');
        normalized = normalized.replace(/<h6\b[^>]*>/gi, '###### ');
        normalized = normalized.replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, '\n');
        normalized = normalized.replace(/<(p|div|section|article)\b[^>]*>/gi, '');
        normalized = normalized.replace(/<[^>]+>/g, '');
        normalized = _decodeHtmlEntities(normalized);
        normalized = normalized.split('\n').map(s => s.trim()).filter(Boolean).join(' / ');
        return normalized || raw;
    }

    function _hasHtmlLikeMarkup(text) {
        return /<\/?[a-z][^>]*>/i.test(String(text == null ? '' : text));
    }

    function _normalizeDocumentInputLines(text) {
        const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n');
        if (!_hasHtmlLikeMarkup(raw)) {
            return { lines: raw.split('\n'), htmlNormalized: false };
        }
        let normalized = raw;
        normalized = normalized.replace(/<br\s*\/?>/gi, '\n');
        normalized = normalized.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');
        normalized = normalized.replace(/<li\b[^>]*>/gi, '- ');
        normalized = normalized.replace(/<h1\b[^>]*>/gi, '# ');
        normalized = normalized.replace(/<h2\b[^>]*>/gi, '## ');
        normalized = normalized.replace(/<h3\b[^>]*>/gi, '### ');
        normalized = normalized.replace(/<h4\b[^>]*>/gi, '#### ');
        normalized = normalized.replace(/<h5\b[^>]*>/gi, '##### ');
        normalized = normalized.replace(/<h6\b[^>]*>/gi, '###### ');
        normalized = normalized.replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, '\n');
        normalized = normalized.replace(/<(p|div|section|article)\b[^>]*>/gi, '');
        normalized = normalized.replace(/<[^>]+>/g, '');
        normalized = _decodeHtmlEntities(normalized);
        const lines = normalized.split('\n').map(s => s.trim()).filter(Boolean);
        return { lines: lines.length ? lines : [''], htmlNormalized: true };
    }

    function _parseSingleFieldSpan(value) {
        const raw = String(value == null ? '' : value).trim();
        const m = raw.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) return null;
        const from = parseInt(m[1], 10);
        const to = parseInt(m[2], 10);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
        return { from: Math.min(from, to), to: Math.max(from, to) };
    }

    function _normalizeSpanArgs(args) {
        const next = { ...(args || {}) };
        const type = _normalizeEditType(next.type);
        const span = _parseSingleFieldSpan(next.from);
        if (!span) return next;
        if (type === 'read' || type === 'replace' || type === 'delete') {
            next.from = span.from;
            if (next.to == null || next.to === '') next.to = span.to;
            return next;
        }
        // 插入类只接受单锚点；用户若传 n-m，则退化为起始位置 n
        if (type === 'insert' || type === 'insert-after' || type === 'insertafter') {
            next.from = span.from;
        }
        return next;
    }

    function _normalizeAnchorArgs(args) {
        const next = { ...(args || {}) };
        const hasBefore = next.before != null && next.before !== '';
        const hasAfter = next.after != null && next.after !== '';
        if (!hasBefore && !hasAfter) return next;
        if (hasBefore && hasAfter) {
            next._anchorConflict = true;
            return next;
        }
        const anchorKey = hasBefore ? 'before' : 'after';
        const anchorValue = next[anchorKey];
        const span = _parseSingleFieldSpan(anchorValue);
        const normalizedType = _normalizeEditType(next.type);
        if (!normalizedType) next.type = hasBefore ? 'insert' : 'insertAfter';
        else if (hasBefore && normalizedType === 'insertafter') next.type = 'insert';
        else if (hasAfter && normalizedType === 'insert') next.type = 'insertAfter';
        next.from = hasBefore ? (span ? span.from : anchorValue) : (span ? span.to : anchorValue);
        delete next.before;
        delete next.after;
        return next;
    }

    function _formatParagraphLines(paragraphs, from, to) {
        return paragraphs.slice(from - 1, to).map((p, i) => `${from + i}: ${_normalizeDocumentDisplayText(p?.text || '')}`);
    }

    function _buildDocumentState(paragraphs, focusFrom, focusTo, options = {}) {
        const total = paragraphs.length;
        const maxLines = Math.max(8, Number(options.maxLines || 80));
        const context = Math.max(2, Number(options.context || 3));
        if (!total) return { total: 0, from: 0, to: 0, lines: [], format: 'line: text', truncated: false };
        let from = 1;
        let to = total;
        if (total > maxLines) {
            const start = Math.max(1, Number(focusFrom || 1));
            const end = Math.max(start, Number(focusTo || start));
            from = Math.max(1, start - context);
            to = Math.min(total, Math.max(end + context, from + maxLines - 1));
            if ((to - from + 1) > maxLines) to = from + maxLines - 1;
            if (to < end) {
                to = end;
                from = Math.max(1, to - maxLines + 1);
            }
        }
        const rawSlice = paragraphs.slice(from - 1, to).map(p => String(p?.text || ''));
        const normalizedLines = _formatParagraphLines(paragraphs, from, to);
        const htmlNormalized = rawSlice.some((line, idx) => _normalizeDocumentDisplayText(line) !== String(line || '').trim());
        return {
            total,
            from,
            to,
            lines: normalizedLines,
            format: 'line: text',
            truncated: from > 1 || to < total,
            representation: htmlNormalized ? 'canvas-normalized-text' : 'plain-text',
            note: htmlNormalized ? '疑似 HTML 段落已标准化为 canvas-editor 文本表示；若仍看到尖括号，请按纯文本理解' : '纯文本段落视图',
        };
    }

    function _previewLines(lines, maxLines = 3, maxChars = 120) {
        const list = (Array.isArray(lines) ? lines : [])
            .map(line => _normalizeDocumentDisplayText(line))
            .filter(Boolean)
            .slice(0, maxLines);
        const joined = list.join(' / ');
        if (joined.length <= maxChars) return joined;
        return joined.slice(0, maxChars - 3) + '...';
    }

    function _buildChangeSummary(kind, from, to, beforeLines = [], afterLines = []) {
        const beforePreview = _previewLines(beforeLines);
        const afterPreview = _previewLines(afterLines);
        const range = from === to ? `${from}` : `${from}-${to}`;
        let brief = '';
        if (kind === 'replace') brief = `替换 ${range}: ${beforePreview || '(空)'} -> ${afterPreview || '(空)'}`;
        else if (kind === 'insert') brief = `插入到 ${range}: ${afterPreview || '(空)'}`;
        else if (kind === 'delete') brief = `删除 ${range}: ${beforePreview || '(空)'}`;
        else if (kind === 'find-replace') brief = `局部替换 ${range}: ${beforePreview || '(空)'} -> ${afterPreview || '(空)'}`;
        return {
            kind,
            range,
            beforeCount: beforeLines.length,
            afterCount: afterLines.length,
            beforePreview,
            afterPreview,
            brief,
        };
    }


    function _headingLevel(text) {
        const normalized = _normalizeDocumentDisplayText(text).trim();
        if (!normalized) return null;
        const hash = normalized.match(/^(#{1,6})\s+/);
        if (hash) return hash[1].length;
        if (/^目录(?:[:：]?)$/.test(normalized)) return 2;
        if (/^第[一二三四五六七八九十百千万0-9]+[章节部分篇]/.test(normalized)) return 2;
        if (/^[一二三四五六七八九十百千万]+[、.．]\s*/.test(normalized)) return 2;
        if (/^\d+(?:\.\d+)*[\.、]\s*/.test(normalized)) return 2;
        return null;
    }

    function _countHeadingLines(lines) {
        return (Array.isArray(lines) ? lines : []).filter(line => _headingLevel(line) != null).length;
    }

    function _headingKey(text) {
        let normalized = _normalizeDocumentDisplayText(text).trim();
        if (!normalized) return '';
        normalized = normalized.replace(/^(#{1,6})\s+/, '');
        normalized = normalized.replace(/^第[一二三四五六七八九十百千万0-9]+[章节部分篇]\s*/, '');
        normalized = normalized.replace(/^[一二三四五六七八九十百千万]+[、.．]\s*/, '');
        normalized = normalized.replace(/^\d+(?:\.\d+)*[\.、]\s*/, '');
        normalized = normalized.replace(/[：:]/g, '');
        normalized = normalized.replace(/\s+/g, '');
        return normalized.trim();
    }

    function _isStructuredSectionHeading(text) {
        const normalized = _normalizeDocumentDisplayText(text).trim();
        if (!normalized) return false;
        return /^目录(?:[:：]?)$/.test(normalized)
            || /^第[一二三四五六七八九十百千万0-9]+[章节部分篇]/.test(normalized)
            || /^[一二三四五六七八九十百千万]+[、.．]\s*/.test(normalized)
            || /^\d+(?:\.\d+)*[\.、]\s*/.test(normalized);
    }

    function _retargetReplaceRangeByHeading(paragraphs, fromIdx, toIdx, newLines) {
        const firstLine = Array.isArray(newLines) && newLines.length ? newLines[0] : '';
        const firstHeadingLevel = _headingLevel(firstLine);
        if (firstHeadingLevel == null) {
            return { fromIdx, toIdx, retargeted: false, retargetedFrom: null };
        }
        if (!_isStructuredSectionHeading(firstLine)) {
            return { fromIdx, toIdx, retargeted: false, retargetedFrom: null };
        }
        const desiredKey = _headingKey(firstLine);
        if (!desiredKey) {
            return { fromIdx, toIdx, retargeted: false, retargetedFrom: null };
        }
        const currentText = paragraphs[fromIdx]?.text || '';
        const currentKey = _headingKey(currentText);
        if (_headingLevel(currentText) != null && currentKey === desiredKey) {
            return { fromIdx, toIdx, retargeted: false, retargetedFrom: null };
        }
        const matches = [];
        for (let i = 0; i < paragraphs.length; i++) {
            const line = paragraphs[i]?.text || '';
            if (_headingLevel(line) == null) continue;
            if (_headingKey(line) !== desiredKey) continue;
            matches.push(i);
        }
        if (matches.length === 1) {
            const offset = Math.max(0, toIdx - fromIdx);
            const nextFrom = matches[0];
            const nextTo = Math.min(paragraphs.length - 1, nextFrom + offset);
            return { fromIdx: nextFrom, toIdx: nextTo, retargeted: true, retargetedFrom: fromIdx + 1 };
        }
        return {
            fromIdx,
            toIdx,
            retargeted: false,
            retargetedFrom: null,
            error: matches.length > 1
                ? `replace: content 以节标题“${_normalizeDocumentDisplayText(firstLine)}”开头，但文档中存在多个同名节标题，无法安全重定向；请先 read 再定位准确范围`
                : `replace: content 以节标题“${_normalizeDocumentDisplayText(firstLine)}”开头，但 from=${fromIdx + 1} 指向的不是该节标题，且文档中找不到唯一匹配；请先 read 再试`,
        };
    }

    function _computeAutoExpandedReplaceTo(paragraphs, fromIdx, toIdx, newLines) {
        const rangeCount = Math.max(1, toIdx - fromIdx + 1);
        const headingCount = _countHeadingLines(newLines);
        const startText = paragraphs[fromIdx]?.text || '';
        if (_headingLevel(startText) == null) return toIdx;
        const firstLine = Array.isArray(newLines) && newLines.length ? newLines[0] : '';
        const firstLineIsStructuredHeading = _isStructuredSectionHeading(firstLine);
        const sameHeadingRewrite = firstLineIsStructuredHeading && _headingKey(firstLine) === _headingKey(startText);
        if (!(sameHeadingRewrite || headingCount > 1 || newLines.length > rangeCount)) return toIdx;
        let seenHeadings = 0;
        let endIdx = paragraphs.length - 1;
        const targetHeadings = Math.max(1, headingCount || (sameHeadingRewrite ? 1 : 0));
        for (let i = fromIdx; i < paragraphs.length; i++) {
            if (_headingLevel(paragraphs[i]?.text || '') != null) {
                seenHeadings += 1;
                if (seenHeadings > targetHeadings) {
                    endIdx = i - 1;
                    break;
                }
            }
        }
        return Math.max(toIdx, endIdx);
    }

    function _hasReadLinePrefix(raw) {
        return /^\s*\d+(?:\s*#\s*[a-z0-9]+)?\s*:\s/i.test(raw) || /\n\s*\d+(?:\s*#\s*[a-z0-9]+)?\s*:\s/i.test(raw);
    }

    function _normalizeFilePath(path) {
        let normalized = String(path || '').trim();
        try { normalized = decodeURIComponent(normalized); } catch (_) { /* ignore */ }
        normalized = normalized
            .replace(/\\/g, '/')
            .replace(/^resource:\/\/file\//i, '')
            .replace(/^file\/(?=[a-z]:\/)/i, '')
            .replace(/^\/(?=[a-z]:\/)/i, '');
        return normalized.toLowerCase();
    }

    function _findOpenMonacoViewerByPath(path) {
        const tm = global.tabManager;
        if (!tm || !path) return null;
        const target = _normalizeFilePath(path);
        const viewers = tm._resourceViewers;
        const tabs = Array.isArray(tm.tabs) ? tm.tabs : [];
        for (const tab of tabs) {
            const viewer = viewers?.get?.(tab.id);
            if (!viewer || !viewer._editor || !viewer._model) continue;
            const viewerPath = viewer.resource?.path || '';
            const tabPath = _normalizeFilePath(String(tab.url || ''));
            const candidate = _normalizeFilePath(viewerPath || tabPath);
            if (candidate && candidate === target) return viewer;
        }
        return null;
    }

    function _updateOpenMonacoViewer(viewer, nextText) {
        const model = viewer?._model || viewer?._editor?.getModel?.();
        if (!model || typeof model.setValue !== 'function') return false;
        if (typeof viewer?._editor?.pushUndoStop === 'function') viewer._editor.pushUndoStop();
        model.setValue(String(nextText || ''));
        if (typeof viewer?._editor?.pushUndoStop === 'function') viewer._editor.pushUndoStop();
        try { viewer._dirty = true; } catch (_) { /* ignore */ }
        return true;
    }

    function _notifyMonacoFileChanged(path, nextText) {
        try { global.MonacoViewer?.notifyFileChanged?.(path, String(nextText || '')); } catch (_) { /* ignore */ }
    }

    function _recordAiFileChange(path, oldText, nextText) {
        if (oldText === nextText) return;
        try { global.aiChangesManager?.addChange?.(path, oldText, nextText); } catch (_) { /* ignore */ }
    }

    class CodeAdapter {
        constructor({ electronAPI }) { this.api = electronAPI; }
        async _readLines(path) {
            const openViewer = _findOpenMonacoViewerByPath(path);
            const openModel = openViewer?._model || openViewer?._editor?.getModel?.();
            if (openModel && typeof openModel.getValue === 'function') {
                return String(openModel.getValue() || '').split('\n');
            }
            const r = await this.api.files.readFile(path, 'utf8');
            const content = typeof r === 'string' ? r : (r?.content ?? r?.data ?? '');
            return String(content).split('\n');
        }
        async _writeLines(path, lines, oldText) {
            const nextText = lines.join('\n');
            const openViewer = _findOpenMonacoViewerByPath(path);
            if (openViewer) _updateOpenMonacoViewer(openViewer, nextText);
            const result = await this.api.files.writeFile(path, nextText, 'utf8');
            const prevText = oldText == null ? '' : String(oldText);
            if (!result || result.success !== false) {
                _notifyMonacoFileChanged(path, nextText);
                _recordAiFileChange(path, prevText, nextText);
            }
            return result;
        }
        async read(args) {
            const lines = await this._readLines(args.path);
            const total = lines.length;
            const from = Math.max(1, args.from || 1);
            const to = Math.min(total, args.to || total);
            const slice = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`);
            return { success: true, total, from, to, content: slice.join('\n') };
        }
        async replace(args) {
            const lines = await this._readLines(args.path);
            const from = Math.max(1, args.from || 1);
            const to = Math.min(lines.length, args.to || from);
            const newLines = String(args.content || '').split('\n');
            const out = lines.slice(0, from - 1).concat(newLines, lines.slice(to));
            await this._writeLines(args.path, out, lines.join('\n'));
            return { success: true, summary: `已替换第 ${from}..${to} 行（共 ${newLines.length} 新行）`, total: out.length };
        }
        async insert(args) {
            // insert: 在 from 行之前插入；若未给 from 则视为 insertAfter at end → 但语义上保持简洁：from 必填或默认 1
            const lines = await this._readLines(args.path);
            const at = Math.max(1, args.from || 1);
            const newLines = String(args.content || '').split('\n');
            const out = lines.slice(0, at - 1).concat(newLines, lines.slice(at - 1));
            await this._writeLines(args.path, out, lines.join('\n'));
            return { success: true, summary: `已在第 ${at} 行之前插入 ${newLines.length} 行`, total: out.length };
        }
        async insertAfter(args) {
            const lines = await this._readLines(args.path);
            const after = Math.max(0, args.from || lines.length);
            const newLines = String(args.content || '').split('\n');
            const out = lines.slice(0, after).concat(newLines, lines.slice(after));
            await this._writeLines(args.path, out, lines.join('\n'));
            return { success: true, summary: `已在第 ${after} 行之后插入 ${newLines.length} 行`, total: out.length };
        }
        async delete_(args) {
            const lines = await this._readLines(args.path);
            const from = Math.max(1, args.from || 1);
            const to = Math.min(lines.length, args.to || from);
            const out = lines.slice(0, from - 1).concat(lines.slice(to));
            await this._writeLines(args.path, out, lines.join('\n'));
            return { success: true, summary: `已删除第 ${from}..${to} 行`, total: out.length };
        }
        async findReplace(args) {
            const lines = await this._readLines(args.path);
            const text = lines.join('\n');
            const find = String(args.find || '');
            if (!find) return { success: false, error: 'findReplace: find 不能为空' };
            const replace = String(args.replace ?? '');
            // 只允许唯一匹配；Aider 风格
            const idx = text.indexOf(find);
            if (idx < 0) return { success: false, error: `findReplace: 未找到 find 文本` };
            if (text.indexOf(find, idx + 1) >= 0) return { success: false, error: 'findReplace: find 文本出现多次，不安全；请扩大 find 上下文使其唯一' };
            const next = text.slice(0, idx) + replace + text.slice(idx + find.length);
            await this._writeLines(args.path, next.split('\n'), text);
            return { success: true, summary: 'findReplace 完成（唯一匹配）', count: 1 };
        }
        async setContent(args) {
            const lines = await this._readLines(args.path);
            const nextText = String(args.content || '');
            await this._writeLines(args.path, nextText.split('\n'), lines.join('\n'));
            return { success: true, summary: 'setContent 完成', total: nextText.split('\n').length };
        }
    }

    class DocumentAdapter {
        constructor({ electronAPI }) { this.api = electronAPI; }
        // 找到当前要编辑的 canvas-editor viewer：优先活动 tab，其次按路径在 _draftEditors / _resourceViewers 中查
        _viewer(args) {
            const tm = global.tabManager;
            if (!tm) return null;
            const helpers = global.AgentV2 || {};
            const find = helpers._findCanvasViewerForTab || _localFindViewerForTab;
            // 优先：args.tabId
            if (args && args.tabId != null) {
                const v = find(tm, args.tabId);
                if (v) return v;
            }
            // 其次：活动标签
            const t = tm.getActiveTab?.();
            if (t) {
                const v = find(tm, t.id);
                if (v) return v;
            }
            // 兜底：path 匹配
            if (args && args.path) {
                const lower = String(args.path).toLowerCase().replace(/\\/g, '/');
                const tabs = tm.tabs || [];
                for (const tab of tabs) {
                    const u = String(tab.url || '').toLowerCase().replace(/\\/g, '/');
                    if (u.includes(lower)) {
                        const v = find(tm, tab.id);
                        if (v) return v;
                    }
                }
            }
            return null;
        }
        _delegateV1(action) {
            // edit manifest 设了 nativeOnly：DocumentAdapter 失败时不回退到 V1（避免 HTML 上下文）
            return { success: false, error: 'DocumentAdapter: 找不到 canvas-editor viewer（请先打开文档标签后再编辑）' + (action ? `; action=${action.type}` : '') };
        }

        _docState(v, focusFrom, focusTo) {
            return _buildDocumentState(v.getParagraphs() || [], focusFrom, focusTo);
        }

        async read(args) {
            const v = this._viewer(args);
            if (!v) return this._delegateV1({ type: 'read' });
            const paragraphs = v.getParagraphs() || [];
            const total = paragraphs.length;
            const from = Math.max(1, args.from || 1);
            const to = Math.min(total, args.to || total);
            const lines = _formatParagraphLines(paragraphs, from, to);
            const docState = this._docState(v, from, to);
            return { success: true, total, from, to, content: lines.join('\n'), kind: 'document/paragraph', note: docState.representation === 'canvas-normalized-text' ? '段格式 "行号: 文本"。疑似 HTML 段落已标准化为 canvas-editor 文本表示；写 content 时只写正文。' : '段格式 "行号: 文本"。系统会在批量 edit 前把数字行号内部锁成稳定段锚点；写 content 时只写正文，不要带行首编号。', docState };
        }

        async replace(args) {
            const v = this._viewer(args);
            if (!v) return this._delegateV1({ type: 'replace' });
            const paragraphs = v.getParagraphs() || [];
            const resolvedFromIdx = _resolveParaRef(paragraphs, args.from, 0);
            const resolvedToIdx = _resolveParaRef(paragraphs, args.to, resolvedFromIdx);
            if (resolvedFromIdx < 0 || resolvedToIdx < 0) return { success: false, error: `replace: 找不到段 from=${args.from} 或 to=${args.to}（段 id 可能已变；请先 read 再试）` };
            const rawContent = String(args.content || '');
            // 检测 AI 误把 read 输出格式 (如 "15#pd: 文本") 当成 content 写入
            const polluted = _hasReadLinePrefix(rawContent);
            if (polluted) {
                return { success: false, error: 'replace: content 里检测到 read 输出的行首编号（如 "12: ..." 或 "12#px: ..."）。写入时只写正文，请去掉每行前缀后重试' };
            }
            const normalizedInput = _normalizeDocumentInputLines(rawContent);
            const newLines = normalizedInput.lines;
            const retarget = _retargetReplaceRangeByHeading(paragraphs, resolvedFromIdx, resolvedToIdx, newLines);
            if (retarget.error) return { success: false, error: retarget.error };
            const fromIdx = retarget.fromIdx;
            const toIdx = retarget.toIdx;
            const effectiveToIdx = _computeAutoExpandedReplaceTo(paragraphs, fromIdx, toIdx, newLines);
            const from = fromIdx + 1;
            const to = effectiveToIdx + 1;
            const autoExpandedRange = effectiveToIdx !== toIdx ? `${from}-${to}` : undefined;
            const beforeLines = paragraphs.slice(from - 1, to).map(p => p.text || '');
            const retargetedRange = retarget.retargeted ? `${retarget.retargetedFrom}->${from}` : undefined;
            // 行数对齐时优先用 applyTextPatches（保留段格式）
            if (typeof v.applyTextPatches === 'function' && newLines.length === (to - from + 1)) {
                const patches = newLines.map((text, i) => {
                    const p = paragraphs[from - 1 + i];
                    return p?.id != null ? { id: p.id, text } : { index: from - 1 + i, text };
                });
                v.applyTextPatches(patches);
                return { success: true, summary: `已替换第 ${from}..${to} 段（保留格式）`, count: patches.length, changeSummary: _buildChangeSummary('replace', from, to, beforeLines, newLines), docState: this._docState(v, from, from + newLines.length - 1), inputNormalization: normalizedInput.htmlNormalized ? 'html-to-text' : undefined, autoExpandedRange, retargetedRange };
            }
            // 否则纯文本重组（会丢失被替换段的格式）
            const allTexts = paragraphs.map(p => p.text || '');
            const out = allTexts.slice(0, from - 1).concat(newLines, allTexts.slice(to));
            v.setTextStream(out.join('\n'));
            return { success: true, summary: `已替换第 ${from}..${to} 段（纯文本模式，原格式丢失）`, total: out.length, warning: 'plain-text-replace', changeSummary: _buildChangeSummary('replace', from, to, beforeLines, newLines), docState: this._docState(v, from, from + newLines.length - 1), inputNormalization: normalizedInput.htmlNormalized ? 'html-to-text' : undefined, autoExpandedRange, retargetedRange };
        }

        async insert(args) {
            // 语义：在 from 段之前插入
            const v = this._viewer(args);
            if (!v) return this._delegateV1({ type: 'insert' });
            const paragraphs = v.getParagraphs() || [];
            const fromIdx = _resolveParaRef(paragraphs, args.from, 0);
            if (fromIdx < 0) return { success: false, error: `insert: 找不到段 from=${args.from}` };
            const rawContent = String(args.content || '');
            if (_hasReadLinePrefix(rawContent)) {
                return { success: false, error: 'insert: content 里检测到 read 输出的行首编号。写入时只写正文' };
            }
            const normalizedInput = _normalizeDocumentInputLines(rawContent);
            const newLines = normalizedInput.lines;
            const texts = paragraphs.map(p => p.text || '');
            const out = texts.slice(0, fromIdx).concat(newLines, texts.slice(fromIdx));
            v.setTextStream(out.join('\n'));
            return { success: true, summary: `已在第 ${fromIdx + 1} 段之前插入 ${newLines.length} 段`, total: out.length, changeSummary: _buildChangeSummary('insert', fromIdx + 1, fromIdx + 1, [], newLines), docState: this._docState(v, fromIdx + 1, fromIdx + newLines.length), inputNormalization: normalizedInput.htmlNormalized ? 'html-to-text' : undefined };
        }

        async insertAfter(args) {
            // 语义：在 from 段之后插入；若 from 缺省则追加到末尾
            const v = this._viewer(args);
            if (!v) return this._delegateV1({ type: 'insertAfter' });
            const paragraphs = v.getParagraphs() || [];
            const afterIdx = (args.from == null || args.from === '')
                ? paragraphs.length - 1
                : _resolveParaRef(paragraphs, args.from, paragraphs.length - 1);
            const insertAt = afterIdx + 1;
            const rawContent = String(args.content || '');
            if (_hasReadLinePrefix(rawContent)) {
                return { success: false, error: 'insertAfter: content 里检测到 read 输出的行首编号。写入时只写正文' };
            }
            const normalizedInput = _normalizeDocumentInputLines(rawContent);
            const newLines = normalizedInput.lines;
            const texts = paragraphs.map(p => p.text || '');
            const out = texts.slice(0, insertAt).concat(newLines, texts.slice(insertAt));
            v.setTextStream(out.join('\n'));
            return { success: true, summary: `已在第 ${afterIdx + 1} 段之后插入 ${newLines.length} 段`, total: out.length, changeSummary: _buildChangeSummary('insert', insertAt + 1, insertAt + 1, [], newLines), docState: this._docState(v, insertAt + 1, insertAt + newLines.length), inputNormalization: normalizedInput.htmlNormalized ? 'html-to-text' : undefined };
        }

        async delete_(args) {
            const v = this._viewer(args);
            if (!v) return this._delegateV1({ type: 'delete' });
            const paragraphs = v.getParagraphs() || [];
            const fromIdx = _resolveParaRef(paragraphs, args.from, 0);
            const toIdx = _resolveParaRef(paragraphs, args.to, fromIdx);
            if (fromIdx < 0 || toIdx < 0) return { success: false, error: `delete: 找不到段 from=${args.from} 或 to=${args.to}` };
            const from = fromIdx + 1; const to = toIdx + 1;
            const beforeLines = paragraphs.slice(from - 1, to).map(p => p.text || '');
            const texts = paragraphs.map(p => p.text || '');
            const out = texts.slice(0, from - 1).concat(texts.slice(to));
            v.setTextStream(out.join('\n'));
            return { success: true, summary: `已删除第 ${from}..${to} 段`, total: out.length, changeSummary: _buildChangeSummary('delete', from, to, beforeLines, []), docState: this._docState(v, Math.max(1, from - 1), Math.max(1, from)) };
        }

        async findReplace(args) {
            const v = this._viewer(args);
            if (!v) return this._delegateV1({ type: 'findReplace' });
            const find = String(args.find || '');
            if (!find) return { success: false, error: 'findReplace: find 不能为空' };
            // 拒绝 HTML 标签（避免误编辑富文本结构）
            if (/<[a-z][^>]*>/i.test(find) || /<[a-z][^>]*>/i.test(args.replace || '')) {
                return { success: false, error: 'findReplace: 文档模式不支持 HTML 标签；请用纯文本片段' };
            }
            const replace = String(args.replace ?? '');
            const paragraphs = v.getParagraphs() || [];
            const all = paragraphs.map(p => p.text || '').join('\n');
            const idx = all.indexOf(find);
            if (idx < 0) return { success: false, error: 'findReplace: 未找到 find 文本' };
            if (all.indexOf(find, idx + 1) >= 0) return { success: false, error: 'findReplace: find 文本出现多次，不安全；请扩大 find 上下文使其唯一' };
            const next = all.slice(0, idx) + replace + all.slice(idx + find.length);
            // 跨段允许（find/replace 可含 \n）
            if (find.includes('\n') || replace.includes('\n')) {
                v.setTextStream(next);
                return { success: true, summary: 'findReplace 完成（跨段，纯文本模式）', count: 1, warning: 'plain-text-replace-cross-paragraph' };
            }
            // 单段：用 patches 保留格式
            if (typeof v.applyTextPatches === 'function') {
                const newParas = next.split('\n');
                if (newParas.length === paragraphs.length) {
                    const patches = [];
                    for (let i = 0; i < paragraphs.length; i++) {
                        if (paragraphs[i].text !== newParas[i]) {
                            patches.push({ id: paragraphs[i].id, index: i, text: newParas[i] });
                        }
                    }
                    if (patches.length) v.applyTextPatches(patches);
                    const focus = patches[0] ? (patches[0].index + 1) : 1;
                    const beforePreview = patches.map(p => paragraphs[p.index]?.text || '');
                    const afterPreview = patches.map(p => newParas[p.index] || '');
                    return { success: true, summary: 'findReplace 完成（保留格式）', count: 1, changeSummary: _buildChangeSummary('find-replace', focus, focus, beforePreview, afterPreview), docState: this._docState(v, focus, focus) };
                }
            }
            v.setTextStream(next);
            return { success: true, summary: 'findReplace 完成（纯文本）', count: 1, changeSummary: _buildChangeSummary('find-replace', 1, Math.min(paragraphs.length, 1), [all], [next]), docState: this._docState(v, 1, Math.min((v.getParagraphs() || []).length, 12)) };
        }

        async setContent(args) {
            const v = this._viewer(args);
            if (!v) return this._delegateV1({ type: 'setContent' });
            const normalizedInput = _normalizeDocumentInputLines(String(args.content || ''));
            v.setTextStream(normalizedInput.lines.join('\n'));
            return { success: true, summary: 'setContent 完成', docState: this._docState(v, 1, Math.min((v.getParagraphs() || []).length, 12)), inputNormalization: normalizedInput.htmlNormalized ? 'html-to-text' : undefined };
        }
    }

    // 当 native-executor 的助手不可见时（例如 smoke 测试不加载 native-executor），用本地兜底
    function _localFindViewerForTab(tm, tabId) {
        if (!tm || tabId == null) return null;
        const peel = (v) => {
            if (!v) return null;
            if (typeof v.getParagraphs === 'function' && typeof v.setTextStream === 'function') return v;
            if (v._editor && typeof v._editor.getParagraphs === 'function') return v._editor;
            return null;
        };
        return peel(tm._draftEditors?.get?.(tabId)) || peel(tm._resourceViewers?.get?.(tabId)) || null;
    }

    class V1BridgeAdapter {
        constructor({ electronAPI }) { this.api = electronAPI; }
        async _exec(action) {
            const ed = global.editorSkill || global.skillManager?.getSkill?.('editor');
            if (!ed) return { success: false, error: 'V1BridgeAdapter: editorSkill not available' };
            const exec = ed.executeAction ? ed.executeAction.bind(ed) : ed.execute.bind(ed);
            try { return await exec(action); }
            catch (e) { return { success: false, error: 'V1BridgeAdapter: ' + (e.message || e) }; }
        }
        read(args) { return this._exec({ type: 'read', lineStart: args.from, lineEnd: args.to }); }
        replace(args) { return this._exec({ type: 'replace', lineStart: args.from, lineEnd: args.to, content: args.content }); }
        insert(args) { return this._exec({ type: 'insert', position: 'before', lineStart: args.from, content: args.content }); }
        insertAfter(args) { return this._exec({ type: 'insert', position: 'after', lineStart: args.from, content: args.content }); }
        delete_(args) { return this._exec({ type: 'delete', lineStart: args.from, lineEnd: args.to }); }
        findReplace(args) { return this._exec({ type: 'findReplace', find: args.find, replace: args.replace }); }
        setContent(args) { return this._exec({ type: 'setContent', content: args.content }); }
    }

    // ════════════════════════════════════════════════════════════════════
    //  PPT / XLSX 路径解析工具
    // ════════════════════════════════════════════════════════════════════

    /** 解析 PPT 路径：
     *   slide:N                 整页
     *   slide:N.title           第一个文本块（启发式）
     *   slide:N.body            正文（除 title 外）；按行映射到剩余文本块
     *   slide:N.t1 / slide:N.t2 按空间顺序的第 N 个文本块（稳定标签）
     *   slide:N.element:ID[.text] 元素 ID 精确寻址
     */
    function _parsePptPath(ref) {
        if (ref == null) return null;
        const s = String(ref).trim();
        const m = s.match(/^slide:(\d+)(?:\.(.+))?$/i);
        if (!m) return null;
        const slideIndex = Math.max(1, parseInt(m[1], 10)) - 1; // 0-based
        const rest = m[2] || '';
        if (!rest) return { slideIndex, scope: 'whole' };
        if (rest === 'title') return { slideIndex, scope: 'title' };
        if (rest === 'body') return { slideIndex, scope: 'body' };
        const lm = rest.match(/^t(\d+)$/i);
        if (lm) return { slideIndex, scope: 'label', labelIndex: parseInt(lm[1], 10) - 1 };
        const em = rest.match(/^element:([^.]+)(?:\.(text))?$/i);
        if (em) return { slideIndex, scope: 'element', elementId: em[1], field: em[2] || 'text' };
        return { slideIndex, scope: 'unknown', raw: rest };
    }

    /** 解析 XLSX 路径：sheet:Name | sheet:Name!A1 | sheet:Name!A1:C5 | sheet:Name!chart | Name!A1 */
    function _parseXlsxPath(ref) {
        if (ref == null) return null;
        let s = String(ref).trim();
        s = s.replace(/^sheet:/i, '');
        const bang = s.indexOf('!');
        let sheetName = '';
        let addr = '';
        if (bang === -1) {
            sheetName = s;
        } else {
            sheetName = s.slice(0, bang);
            addr = s.slice(bang + 1).trim();
        }
        if (!addr) return { sheetName, scope: 'whole' };
        if (/^chart$/i.test(addr)) return { sheetName, scope: 'chart' };
        const rangeM = addr.match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/);
        if (!rangeM) return { sheetName, scope: 'unknown', raw: addr };
        const colToIdx = (c) => {
            let n = 0;
            const up = c.toUpperCase();
            for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
            return n - 1;
        };
        const r1 = parseInt(rangeM[2], 10) - 1;
        const c1 = colToIdx(rangeM[1]);
        if (rangeM[3]) {
            const r2 = parseInt(rangeM[4], 10) - 1;
            const c2 = colToIdx(rangeM[3]);
            return {
                sheetName, scope: 'range',
                row1: Math.min(r1, r2), col1: Math.min(c1, c2),
                row2: Math.max(r1, r2), col2: Math.max(c1, c2),
            };
        }
        return { sheetName, scope: 'cell', row: r1, col: c1 };
    }

    /** 列号 → A/B/...AA */
    function _colLetter(c) {
        let s = ''; let n = c;
        while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
        return s;
    }

    /** 通用：找当前活动 PPT/XLSX viewer */
    function _findActiveViewer(targetType) {
        const ed = global.editorSkill;
        if (ed && typeof ed._findEditorTab === 'function') {
            const info = ed._findEditorTab();
            if (info && info.viewerType === targetType) return info.viewer;
        }
        return null;
    }

    // ════════════════════════════════════════════════════════════════════
    //  PptAdapter — 路径式 PPT 编辑
    // ════════════════════════════════════════════════════════════════════
    class PptAdapter {
        constructor({ electronAPI } = {}) { this.api = electronAPI; }

        _viewer() {
            const v = _findActiveViewer('ppt');
            if (!v) throw new Error('PptAdapter: 未找到活动 PPT 标签');
            return v;
        }
        _deck(viewer) {
            const ed = global.editorSkill;
            if (ed && typeof ed._pptActiveDeck === 'function') return ed._pptActiveDeck(viewer);
            return viewer?._deck || null;
        }
        _reload(viewer, deck, label) {
            try {
                const w = viewer?._iframe?.contentWindow;
                if (w?.HpLab?.loadDeck) w.HpLab.loadDeck(deck, label || 'ai-edit');
            } catch (_) { /* ignore */ }
            try { viewer._dirty = true; } catch (_) { }
        }
        /**
         * 收集 slide 中所有可写文本块（按空间顺序：top→bottom，left→right）
         * 真实 schema：
         *   - text 元素：el.runs[].text
         *   - shape 元素：el.text.runs[].text（嵌套）
         *   - shape 元素 paragraphs：el.text.paragraphs[].runs[].text
         *   - table 元素：el.rows[r][c].runs[].text（矩阵 + cell.runs）
         * 每个 owner 代表一个"完整文本块"（所有 runs 拼接），写入时把内容写到第一个 run 并清掉其余 run
         */
        _collectTextOwners(slide) {
            const out = [];
            const pushOwner = (el, parent, kind, runs, extra = {}) => {
                if (!Array.isArray(runs) || !runs.length) return;
                if (!runs.some(r => r && typeof r.text === 'string')) return;
                out.push({ el, parent, kind, runs, ...extra });
            };
            const walkText = (el, parent) => {
                // text/placeholder：el.runs
                if (Array.isArray(el.runs)) pushOwner(el, parent, 'el-runs', el.runs);
                // shape/text：el.text.runs
                if (el.text && Array.isArray(el.text.runs)) pushOwner(el, parent, 'el-text-runs', el.text.runs);
                // shape：el.text.paragraphs
                if (el.text && Array.isArray(el.text.paragraphs)) {
                    el.text.paragraphs.forEach((p, pi) => {
                        if (Array.isArray(p?.runs)) pushOwner(el, parent, 'el-text-para-runs', p.runs, { paraIndex: pi, para: p });
                    });
                }
                // 顶级 paragraphs（旧版本兼容）
                if (Array.isArray(el.paragraphs)) {
                    el.paragraphs.forEach((p, pi) => {
                        if (Array.isArray(p?.runs)) pushOwner(el, parent, 'el-para-runs', p.runs, { paraIndex: pi, para: p });
                    });
                }
                // table：el.rows[r][c].runs
                if (Array.isArray(el.rows)) {
                    el.rows.forEach((row, ri) => {
                        if (!Array.isArray(row)) return;
                        row.forEach((cell, ci) => {
                            if (cell && Array.isArray(cell.runs)) {
                                pushOwner(el, parent, 'cell-runs', cell.runs, { rowIndex: ri, colIndex: ci, cell });
                            }
                        });
                    });
                }
                // group：children
                if (Array.isArray(el.children)) el.children.forEach(c => walkText(c, el));
            };
            (slide.elements || []).forEach(e => walkText(e, null));
            // 按空间顺序排序：先按所属 element 的 y，再按 x；table 单元格按 row,col 内序
            out.sort((a, b) => {
                const ay = a.el?.geom?.y ?? 0, by = b.el?.geom?.y ?? 0;
                if (ay !== by) return ay - by;
                const ax = a.el?.geom?.x ?? 0, bx = b.el?.geom?.x ?? 0;
                if (ax !== bx) return ax - bx;
                const ari = a.rowIndex ?? -1, bri = b.rowIndex ?? -1;
                if (ari !== bri) return ari - bri;
                const aci = a.colIndex ?? -1, bci = b.colIndex ?? -1;
                if (aci !== bci) return aci - bci;
                return (a.paraIndex ?? 0) - (b.paraIndex ?? 0);
            });
            // 给每个 owner 指派稳定标签：t1, t2, ...
            out.forEach((o, i) => { o.label = `t${i + 1}`; });
            return out;
        }
        _ownerText(o) {
            return (o.runs || []).map(r => (r && typeof r.text === 'string') ? r.text : '').join('');
        }
        _setOwnerText(o, txt) {
            if (!Array.isArray(o.runs) || !o.runs.length) return;
            // 模板：保留第一个 run 的样式，其余清空
            const tmpl = o.runs[0];
            tmpl.text = String(txt);
            o.runs.length = 1;
        }
        _ownerRoleHint(o) {
            // 简单角色推断：第一个为 title；type=table → cell；其余为 body
            if (o.kind === 'cell-runs') return `cell[${o.rowIndex},${o.colIndex}]`;
            if (o._isTitle) return 'title';
            return 'body';
        }
        _findElementById(slide, id) {
            const result = { el: null, parent: null };
            const walk = (e, parent) => {
                if (result.el) return;
                if (e && e.id === id) { result.el = e; result.parent = parent; return; }
                (e?.children || []).forEach(c => walk(c, e));
            };
            (slide.elements || []).forEach(e => walk(e, null));
            return result;
        }

        /** 把 slide 渲染成结构化文本：
         *   [t1·title] xxx
         *   [t2·body] xxx
         *   [t3·body] yyy
         */
        _renderSlideStructured(slide) {
            const owners = this._collectTextOwners(slide);
            if (owners.length) {
                // 启发式：第一个文本块作为 title（一般在最顶部）
                owners[0]._isTitle = true;
                // 字号最大的也标 title（兼容标题不在最顶部的页）
                let maxSize = 0, maxIdx = -1;
                owners.forEach((o, i) => {
                    const sz = (o.runs?.[0]?.size) || 0;
                    if (sz > maxSize) { maxSize = sz; maxIdx = i; }
                });
                if (maxIdx >= 0 && maxSize >= 24) {
                    owners.forEach(o => o._isTitle = false);
                    owners[maxIdx]._isTitle = true;
                }
            }
            const lines = [];
            owners.forEach(o => {
                const role = this._ownerRoleHint(o);
                const text = this._ownerText(o).replace(/\s+/g, ' ').trim();
                if (!text) return;
                lines.push(`[${o.label}·${role}] ${text}`);
            });
            return { lines, owners };
        }

        async read(args) {
            const v = this._viewer();
            const deck = this._deck(v);
            if (!deck) return { success: false, error: 'PPT viewer 未就绪' };
            const path = _parsePptPath(args.from);
            if (!path) {
                // 默认：所有页结构化文本（前 5 页全部 + 其余页前 3 块）
                const slides = deck.slides || [];
                const FULL_PAGES = 5;
                const TAIL_BLOCKS = 3;
                const out = [`# 演示文稿 (共 ${slides.length} 页)`];
                slides.forEach((s, i) => {
                    const { lines } = this._renderSlideStructured(s);
                    out.push(`\n=== slide:${i + 1} (${lines.length} 文本块) ===`);
                    if (i < FULL_PAGES) {
                        out.push(...lines);
                    } else {
                        out.push(...lines.slice(0, TAIL_BLOCKS));
                        if (lines.length > TAIL_BLOCKS) out.push(`  ...(共 ${lines.length} 块，已略)`);
                    }
                });
                out.push('\n提示：');
                out.push('  • replace slide:N.t1  内容="..."  → 按标签精确替换某文本块');
                out.push('  • replace slide:N.title 内容="..."  → 替换标题');
                out.push('  • replace slide:N.body  内容="行1\\n行2"  → 按行写入剩余文本块');
                out.push('  • read   slide:N  → 查看某页所有元素详情（含 element:ID）');
                out.push('  • insert slide:N  内容="..."  → 在此页空闲位置追加正文文本');
                return { success: true, content: out.join('\n'), slideCount: slides.length, format: 'structured' };
            }
            const slide = deck.slides[path.slideIndex];
            if (!slide) return { success: false, error: `slide:${path.slideIndex + 1} 不存在` };
            if (path.scope === 'whole') {
                // 单页详情：结构化文本 + 完整 element 清单
                const { lines } = this._renderSlideStructured(slide);
                const elList = (slide.elements || []).map((el, idx) => {
                    const id = el.id || `_${idx}`;
                    const type = el.type || el.kind || '?';
                    const g = el.geom || {};
                    const preview = (this._renderSlideStructured({ elements: [el] }).lines[0] || '').slice(0, 60);
                    return `  #${id}  type=${type}  pos=(${g.x || 0},${g.y || 0})  size=(${g.w || 0}×${g.h || 0})  ${preview}`;
                });
                const out = [`# slide:${path.slideIndex + 1}`, '## 结构化文本', ...lines, '', '## 元素清单', ...elList];
                return { success: true, content: out.join('\n'), elementCount: slide.elements?.length || 0 };
            }
            if (path.scope === 'element') {
                const found = this._findElementById(slide, path.elementId);
                if (!found.el) return { success: false, error: `element:${path.elementId} 不存在` };
                const { lines } = this._renderSlideStructured({ elements: [found.el] });
                return { success: true, content: lines.join('\n'), elementId: path.elementId };
            }
            const { lines, owners } = this._renderSlideStructured(slide);
            if (path.scope === 'title') {
                const t = owners.find(o => o._isTitle) || owners[0];
                return { success: true, content: t ? this._ownerText(t) : '', scope: 'title' };
            }
            if (path.scope === 'body') {
                const body = owners.filter(o => !o._isTitle).map(o => this._ownerText(o)).join('\n');
                return { success: true, content: body, scope: 'body', blockCount: owners.length };
            }
            if (path.scope === 'label') {
                const o = owners[path.labelIndex];
                if (!o) return { success: false, error: `slide:${path.slideIndex + 1} 没有第 ${path.labelIndex + 1} 个文本块` };
                return { success: true, content: this._ownerText(o), label: o.label };
            }
            return { success: false, error: `不支持的路径: ${args.from}\n可用提示:\n${lines.join('\n')}` };
        }

        async replace(args) {
            const v = this._viewer();
            const deck = this._deck(v);
            if (!deck) return { success: false, error: 'PPT viewer 未就绪' };
            const path = _parsePptPath(args.from);
            if (!path) return { success: false, error: 'PPT replace 需要 from=slide:N[.title|.body|.tN|.element:ID.text]' };
            const slide = deck.slides[path.slideIndex];
            if (!slide) return { success: false, error: `slide:${path.slideIndex + 1} 不存在` };
            const content = String(args.content == null ? '' : args.content);

            if (path.scope === 'whole') {
                let spec;
                try { spec = JSON.parse(content); } catch { return { success: false, error: '整页 replace 的 content 必须是 JSON（{title,subtitle,items,...}）' }; }
                const newSlide = global.editorSkill?._pptBuildTextSlide?.(spec);
                if (!newSlide) return { success: false, error: '_pptBuildTextSlide 不可用' };
                deck.slides.splice(path.slideIndex, 1, newSlide);
                this._reload(v, deck, 'ai-edit-slide-replace');
                return { success: true, summary: `已重建 slide:${path.slideIndex + 1}` };
            }
            if (path.scope === 'element') {
                const found = this._findElementById(slide, path.elementId);
                if (!found.el) return { success: false, error: `element:${path.elementId} 不存在` };
                if (path.field === 'text') {
                    // 找到该 element 内第一个 owner，写入
                    const owners = this._collectTextOwners({ elements: [found.el] });
                    if (owners.length) {
                        this._setOwnerText(owners[0], content);
                    } else if (Array.isArray(found.el.runs)) {
                        found.el.runs = [{ text: content, size: 18 }];
                    } else {
                        found.el.text = found.el.text || {};
                        found.el.text.runs = [{ text: content, size: 18 }];
                    }
                    this._reload(v, deck, 'ai-edit-element-text');
                    return { success: true, summary: `已更新 element:${path.elementId}` };
                }
                return { success: false, error: `不支持字段: ${path.field}` };
            }
            const { owners } = this._renderSlideStructured(slide);
            if (!owners.length) {
                // 无可写文本块：自动 insert 一段正文
                return this._insertBodyText(v, deck, slide, path.slideIndex, content);
            }
            if (path.scope === 'title') {
                const t = owners.find(o => o._isTitle) || owners[0];
                this._setOwnerText(t, content);
                this._reload(v, deck, 'ai-edit-title');
                return { success: true, summary: `已更新 slide:${path.slideIndex + 1} 标题` };
            }
            if (path.scope === 'body') {
                const lines = content.split(/\r?\n/);
                const targets = owners.filter(o => !o._isTitle);
                if (!targets.length) {
                    return this._insertBodyText(v, deck, slide, path.slideIndex, content);
                }
                lines.forEach((line, i) => {
                    if (i < targets.length) this._setOwnerText(targets[i], line);
                });
                if (lines.length > targets.length) {
                    const last = targets[targets.length - 1];
                    const extra = lines.slice(targets.length).join('\n');
                    this._setOwnerText(last, this._ownerText(last) + ' ' + extra);
                }
                this._reload(v, deck, 'ai-edit-body');
                return { success: true, summary: `已更新 slide:${path.slideIndex + 1} 正文 (${Math.min(lines.length, targets.length)} 块)` };
            }
            if (path.scope === 'label') {
                const o = owners[path.labelIndex];
                if (!o) return { success: false, error: `slide:${path.slideIndex + 1} 没有第 ${path.labelIndex + 1} 个文本块（共 ${owners.length}）` };
                this._setOwnerText(o, content);
                this._reload(v, deck, 'ai-edit-label');
                return { success: true, summary: `已更新 ${o.label}` };
            }
            return { success: false, error: `不支持的路径: ${args.from}` };
        }

        /** 智能插入正文：在 slide 空闲位置追加一个 text 元素 */
        _insertBodyText(viewer, deck, slide, slideIndex, content) {
            const elements = slide.elements || (slide.elements = []);
            // 找出当前最大 y+h（占位最低点），下方插入
            let lowestY = 0;
            elements.forEach(el => {
                const g = el.geom || {};
                lowestY = Math.max(lowestY, (g.y || 0) + (g.h || 0));
            });
            const SLIDE_H = deck.size?.h || 6858000;
            const SLIDE_W = deck.size?.w || 9144000;
            const margin = Math.round(SLIDE_W * 0.06);
            const newY = Math.max(Math.round(SLIDE_H * 0.12), Math.min(lowestY + Math.round(SLIDE_H * 0.03), SLIDE_H - Math.round(SLIDE_H * 0.2)));
            const newH = Math.min(Math.round(SLIDE_H * 0.18), SLIDE_H - newY - Math.round(SLIDE_H * 0.05));
            const newEl = {
                id: 'el-ai-' + Date.now().toString(36),
                type: 'text',
                geom: { x: margin, y: newY, w: SLIDE_W - margin * 2, h: newH },
                runs: [{ text: String(content), size: 18, color: '#1f2937' }],
                align: 'left',
                valign: 'top',
                autoFit: true,
            };
            elements.push(newEl);
            this._reload(viewer, deck, 'ai-insert-body-text');
            return { success: true, summary: `已在 slide:${slideIndex + 1} 追加正文文本块`, elementId: newEl.id };
        }

        async insertAfter(args) {
            const v = this._viewer();
            const deck = this._deck(v);
            if (!deck) return { success: false, error: 'PPT viewer 未就绪' };
            const path = _parsePptPath(args.from);
            const content = String(args.content || '');
            // 若 content 是 JSON → 整页插入；否则在 from 指定的页内追加文本块
            if (path && content.trim().startsWith('{')) {
                let spec;
                try { spec = JSON.parse(content); }
                catch { return { success: false, error: 'insertAfter content 不是合法 JSON：如需插页传 JSON，如需追加文本传纯字符串' }; }
                const slide = global.editorSkill?._pptBuildTextSlide?.(spec);
                if (!slide) return { success: false, error: '_pptBuildTextSlide 不可用' };
                const at = path.slideIndex + 1;
                deck.slides.splice(at, 0, slide);
                this._reload(v, deck, 'ai-insert-slide');
                return { success: true, summary: `已在 slide:${at} 后插入新页`, slideIndex: at + 1 };
            }
            // 纯文本：往指定页（或末页）追加文本块
            const slideIdx = path ? path.slideIndex : deck.slides.length - 1;
            const slide = deck.slides[slideIdx];
            if (!slide) return { success: false, error: `slide:${slideIdx + 1} 不存在` };
            return this._insertBodyText(v, deck, slide, slideIdx, content);
        }
        async insert(args) { return this.insertAfter(args); }

        async delete_(args) {
            const v = this._viewer();
            const deck = this._deck(v);
            if (!deck) return { success: false, error: 'PPT viewer 未就绪' };
            const path = _parsePptPath(args.from);
            if (!path) return { success: false, error: 'PPT delete 需要 from=slide:N' };
            if (path.scope === 'whole') {
                if (path.slideIndex < 0 || path.slideIndex >= deck.slides.length) {
                    return { success: false, error: `slide:${path.slideIndex + 1} 不存在` };
                }
                deck.slides.splice(path.slideIndex, 1);
                this._reload(v, deck, 'ai-delete-slide');
                return { success: true, summary: `已删除 slide:${path.slideIndex + 1}`, slideCount: deck.slides.length };
            }
            if (path.scope === 'element') {
                const slide = deck.slides[path.slideIndex];
                if (!slide) return { success: false, error: `slide:${path.slideIndex + 1} 不存在` };
                const before = (slide.elements || []).length;
                slide.elements = (slide.elements || []).filter(e => e.id !== path.elementId);
                if (slide.elements.length === before) return { success: false, error: `element:${path.elementId} 不存在` };
                this._reload(v, deck, 'ai-delete-element');
                return { success: true, summary: `已删除 element:${path.elementId}` };
            }
            return { success: false, error: `不支持的删除路径: ${args.from}` };
        }

        async findReplace(args) {
            const v = this._viewer();
            // 复用 v1 EditorSkill 的全局替换实现
            const ed = global.editorSkill;
            if (!ed?._pptFindReplace) return { success: false, error: 'PPT findReplace 不可用' };
            return ed._pptFindReplace({ find: args.find, replace: args.replace, regex: args.regex }, v);
        }

        async setContent() {
            return { success: false, error: 'PPT 禁止使用 set-content（会摧毁版式）；请用 replace/insertAfter/delete 增量修改' };
        }

        /** 从当前 deck 反向抽取 slides 规格（用于 regenerate 时保留原页内容） */
        _extractSlideSpecs(deck) {
            const specs = [];
            (deck.slides || []).forEach((s) => {
                const { lines, owners } = this._renderSlideStructured(s);
                if (!owners.length) {
                    specs.push({ type: 'bullet', title: '', body: [] });
                    return;
                }
                const titleOwner = owners.find(o => o._isTitle) || owners[0];
                const title = this._ownerText(titleOwner).trim();
                const body = owners.filter(o => o !== titleOwner)
                    .map(o => this._ownerText(o).trim())
                    .filter(Boolean);
                specs.push({ type: body.length ? 'bullet' : 'cover', title, body });
            });
            return specs;
        }

        /** 计算去重后的"另存为"路径：foo.pptx → foo_v2.pptx → foo_v3.pptx */
        async _deriveNewPath(origPath) {
            const m = String(origPath || '').match(/^(.*?)(?:_v(\d+))?(\.pptx)$/i);
            if (!m) return origPath + '_v2.pptx';
            const base = m[1];
            const startV = m[2] ? parseInt(m[2], 10) + 1 : 2;
            const fsExists = this.api?.fs?.exists;
            if (typeof fsExists !== 'function') {
                // 无 fs.exists：直接附加时间戳，避免覆盖
                const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
                return `${base}_v${startV}_${stamp}${m[3]}`;
            }
            for (let v = startV; v < startV + 50; v++) {
                const candidate = `${base}_v${v}${m[3]}`;
                try {
                    const exists = await fsExists(candidate);
                    if (!exists) return candidate;
                } catch { return candidate; }
            }
            return `${base}_v${Date.now()}${m[3]}`;
        }

        /**
         * regenerate — 用 createEmptyPptx 生成全新文件
         *   from: "slide:N"        → 在原页之后插入修改后的页面（保留原 deck 全部内容）
         *   from: "all" / 不传     → 完全用 args.slides 生成新 PPT
         *   args: { from, spec?, slides?, title?, theme?, colorway?, aspectRatio?, templateId? }
         */
        async regenerate(args) {
            const v = this._viewer();
            const deck = this._deck(v);
            if (!deck) return { success: false, error: 'PPT viewer 未就绪' };
            const origPath = v?.resource?.path || v?.resource?.filePath || '';
            if (!origPath) return { success: false, error: '无法获取当前 PPT 文件路径' };

            const path = _parsePptPath(args.from);
            const isAll = !path || /^all$/i.test(String(args.from || ''));

            let slidesSpec;
            if (isAll) {
                if (!Array.isArray(args.slides) || !args.slides.length) {
                    return { success: false, error: 'regenerate from=all 需要 slides:[{title,body,...},...]' };
                }
                slidesSpec = args.slides;
            } else {
                if (!args.spec || typeof args.spec !== 'object') {
                    return { success: false, error: `regenerate from=slide:${path.slideIndex + 1} 需要 spec:{title,body,...}` };
                }
                slidesSpec = this._extractSlideSpecs(deck);
                slidesSpec.splice(path.slideIndex + 1, 0, args.spec);
            }

            const newPath = await this._deriveNewPath(origPath);
            const payload = {
                path: newPath,
                title: args.title || (deck.meta?.title || ''),
                aspectRatio: args.aspectRatio || '16:9',
                templateId: args.templateId || 'ppt-blank',
                theme: args.theme || null,
                colorway: args.colorway || null,
                slides: slidesSpec,
            };
            const r = await this.api?.workbench?.createEmptyPptx?.(payload);
            if (!r || r.error) return { success: false, error: r?.error || 'createEmptyPptx 失败', path: newPath };

            // 打开新文件
            try {
                const tm = global.tabManager;
                if (tm?.openResource) tm.openResource(newPath);
                else if (tm?.openFile) tm.openFile(newPath);
                else if (this.api?.app?.openFile) this.api.app.openFile(newPath);
            } catch (_) { /* ignore */ }

            return {
                success: true,
                summary: isAll
                    ? `已生成全新 PPT (${slidesSpec.length} 页) → ${newPath}`
                    : `已在 slide:${path.slideIndex + 2} 位置插入修改页 → ${newPath}`,
                path: newPath,
                slideCount: slidesSpec.length,
            };
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  XlsxAdapter — 路径式 XLSX 编辑
    // ════════════════════════════════════════════════════════════════════
    class XlsxAdapter {
        constructor({ electronAPI } = {}) { this.api = electronAPI; }

        _viewer() {
            const v = _findActiveViewer('xlsx');
            if (!v) throw new Error('XlsxAdapter: 未找到活动 XLSX 标签');
            return v;
        }
        _resolveSheet(viewer, name) {
            const sheets = viewer._sheets || [];
            if (!name) return { sheet: sheets[viewer._activeSheet || 0], idx: viewer._activeSheet || 0 };
            const idx = sheets.findIndex(s => s && s.name === name);
            if (idx < 0) return { sheet: null, idx: -1 };
            return { sheet: sheets[idx], idx };
        }
        _switchSheetIfNeeded(viewer, idx) {
            if (idx >= 0 && viewer._activeSheet !== idx && typeof viewer._switchSheet === 'function') {
                try { viewer._switchSheet(idx); } catch (_) { }
            }
        }
        _afterWrite(viewer) {
            try { viewer._dirty = true; viewer._renderGrid?.(); viewer._render?.(); } catch (_) { }
        }

        async read(args) {
            const v = this._viewer();
            const path = _parseXlsxPath(args.from);
            const cellStr = (cell) => {
                if (cell == null) return '';
                if (typeof cell === 'object') return String(cell.v ?? cell.f ?? '');
                return String(cell);
            };
            if (!path) {
                // 默认：所有 sheet 的前 20 行 × 前 10 列
                const sheets = v._sheets || [];
                const ROW_LIMIT = 20;
                const COL_LIMIT = 10;
                const out = [`# 工作簿摘要 (共 ${sheets.length} 个 sheet)`];
                sheets.forEach((sheet, idx) => {
                    if (!sheet) return;
                    const rows = sheet.rows || [];
                    const totalRows = rows.length;
                    const totalCols = rows[0]?.length || 0;
                    out.push(`\n=== sheet:${sheet.name}  (${totalRows} 行 × ${totalCols} 列${idx === v._activeSheet ? ' · 当前' : ''}) ===`);
                    const r2 = Math.min(rows.length, ROW_LIMIT);
                    for (let r = 0; r < r2; r++) {
                        const row = rows[r] || [];
                        const c2 = Math.min(row.length, COL_LIMIT);
                        const cells = [];
                        for (let c = 0; c < c2; c++) cells.push(cellStr(row[c]).slice(0, 50));
                        out.push(cells.join('\t'));
                    }
                    if (totalRows > ROW_LIMIT) out.push(`  ...(共 ${totalRows} 行，已略)`);
                });
                out.push('\n提示：read sheet:Name!A1:E50 读取指定范围；replace sheet:Name!B5 写单元格');
                return { success: true, content: out.join('\n'), format: 'summary', sheets: sheets.map(s => s?.name) };
            }
            const { sheet } = this._resolveSheet(v, path.sheetName);
            if (!sheet) return { success: false, error: `sheet:${path.sheetName} 不存在` };
            const rows = sheet.rows || [];
            if (path.scope === 'whole') {
                const totalRows = rows.length;
                const totalCols = rows[0]?.length || 0;
                const r1 = 0, r2 = Math.min(rows.length - 1, 49);
                const lines = [];
                for (let r = r1; r <= r2; r++) {
                    const row = rows[r] || [];
                    lines.push(row.map(cellStr).join('\t'));
                }
                return { success: true, content: lines.join('\n'), sheet: sheet.name, totalRows, totalCols, format: 'tsv' };
            }
            if (path.scope === 'cell') {
                const cell = rows[path.row]?.[path.col];
                return { success: true, content: cellStr(cell), address: _colLetter(path.col) + (path.row + 1) };
            }
            if (path.scope === 'range') {
                const lines = [];
                for (let r = path.row1; r <= path.row2; r++) {
                    const cells = [];
                    for (let c = path.col1; c <= path.col2; c++) cells.push(cellStr(rows[r]?.[c]));
                    lines.push(cells.join('\t'));
                }
                return { success: true, content: lines.join('\n'), format: 'tsv' };
            }
            return { success: false, error: `不支持的路径: ${args.from}` };
        }

        async replace(args) {
            const v = this._viewer();
            const path = _parseXlsxPath(args.from);
            if (!path) return { success: false, error: 'XLSX replace 需要 from=sheet:Name!A1' };
            const { sheet, idx } = this._resolveSheet(v, path.sheetName);
            if (!sheet) return { success: false, error: `sheet:${path.sheetName} 不存在` };
            this._switchSheetIfNeeded(v, idx);
            const content = String(args.content == null ? '' : args.content);

            if (path.scope === 'cell') {
                v._setCellValue(path.row, path.col, content);
                this._afterWrite(v);
                return { success: true, summary: `已写入 ${_colLetter(path.col)}${path.row + 1}` };
            }
            if (path.scope === 'range') {
                const lines = content.split(/\r?\n/);
                let written = 0;
                for (let r = path.row1, ri = 0; r <= path.row2 && ri < lines.length; r++, ri++) {
                    const cells = lines[ri].split('\t');
                    for (let c = path.col1, ci = 0; c <= path.col2 && ci < cells.length; c++, ci++) {
                        v._setCellValue(r, c, cells[ci]);
                        written++;
                    }
                }
                this._afterWrite(v);
                return { success: true, summary: `已写入 ${written} 个单元格` };
            }
            return { success: false, error: `XLSX replace 不支持路径 scope: ${path.scope}` };
        }

        async insertAfter(args) {
            // 在指定 sheet 之后新增 sheet，content = 新 sheet 名
            const v = this._viewer();
            const path = _parseXlsxPath(args.from);
            const newName = String(args.content || '').trim();
            if (!newName) return { success: false, error: '新 sheet 名不能为空（写在 content 字段）' };
            const sheets = v._sheets || [];
            const { idx } = path ? this._resolveSheet(v, path.sheetName) : { idx: sheets.length - 1 };
            const insertAt = (idx >= 0 ? idx : sheets.length - 1) + 1;
            if (sheets.some(s => s && s.name === newName)) {
                return { success: false, error: `sheet:${newName} 已存在` };
            }
            if (typeof v._addSheet === 'function') {
                v._addSheet(newName, insertAt);
            } else {
                sheets.splice(insertAt, 0, { name: newName, rows: [[]] });
            }
            this._afterWrite(v);
            return { success: true, summary: `已新增 sheet:${newName}`, index: insertAt };
        }
        async insert(args) {
            // sheet:Name!chart 插图表
            const path = _parseXlsxPath(args.from);
            if (path && path.scope === 'chart') return this._insertChart(args, path);
            return this.insertAfter(args);
        }

        async _insertChart(args, path) {
            const v = this._viewer();
            const { sheet, idx } = this._resolveSheet(v, path.sheetName);
            if (!sheet) return { success: false, error: `sheet:${path.sheetName} 不存在` };
            this._switchSheetIfNeeded(v, idx);
            let spec;
            try { spec = JSON.parse(String(args.content || '{}')); }
            catch { return { success: false, error: 'chart content 必须是 JSON：{type, range, title, anchor}' }; }
            const cm = global.ChartManager;
            if (!cm || typeof cm.createChart !== 'function') {
                return { success: false, error: 'window.ChartManager 不可用，无法插入图表' };
            }
            try {
                const chart = await cm.createChart({
                    sheetName: sheet.name,
                    type: spec.type || 'bar',
                    range: spec.range,
                    title: spec.title || '',
                    anchor: spec.anchor || 'E2',
                    viewer: v,
                });
                this._afterWrite(v);
                return { success: true, summary: `已插入 ${spec.type || 'bar'} 图表`, chartId: chart && chart.id };
            } catch (e) {
                return { success: false, error: 'createChart 失败: ' + (e.message || e) };
            }
        }

        async delete_(args) {
            const v = this._viewer();
            const path = _parseXlsxPath(args.from);
            if (!path) return { success: false, error: 'XLSX delete 需要 from=sheet:Name[!A1[:Z9]]' };
            const { sheet, idx } = this._resolveSheet(v, path.sheetName);
            if (!sheet) return { success: false, error: `sheet:${path.sheetName} 不存在` };
            if (path.scope === 'whole') {
                const sheets = v._sheets || [];
                if (sheets.length <= 1) return { success: false, error: '不能删除最后一个 sheet' };
                if (typeof v._removeSheet === 'function') v._removeSheet(idx);
                else sheets.splice(idx, 1);
                this._afterWrite(v);
                return { success: true, summary: `已删除 sheet:${sheet.name}` };
            }
            if (path.scope === 'cell') {
                v._setCellValue(path.row, path.col, '');
                this._afterWrite(v);
                return { success: true, summary: `已清空 ${_colLetter(path.col)}${path.row + 1}` };
            }
            if (path.scope === 'range') {
                this._switchSheetIfNeeded(v, idx);
                for (let r = path.row1; r <= path.row2; r++) {
                    for (let c = path.col1; c <= path.col2; c++) v._setCellValue(r, c, '');
                }
                this._afterWrite(v);
                return { success: true, summary: '已清空区域' };
            }
            return { success: false, error: `不支持的删除路径: ${args.from}` };
        }

        async findReplace(args) {
            const v = this._viewer();
            const ed = global.editorSkill;
            if (!ed?._xlsxFindReplace) return { success: false, error: 'XLSX findReplace 不可用' };
            return ed._xlsxFindReplace({ find: args.find, replace: args.replace, regex: args.regex }, v);
        }

        async setContent() {
            return { success: false, error: 'XLSX 禁止 set-content（会清空所有 sheet）；请用 replace/insertAfter/delete 增量修改' };
        }
    }

    class LineEditAdapter {
        constructor({ electronAPI } = {}) {
            this.api = electronAPI || global.electronAPI || null;
            this._code = new CodeAdapter({ electronAPI: this.api });
            this._doc = new DocumentAdapter({ electronAPI: this.api });
            this._v1 = new V1BridgeAdapter({ electronAPI: this.api });
            this._ppt = new PptAdapter({ electronAPI: this.api });
            this._xlsx = new XlsxAdapter({ electronAPI: this.api });
        }

        // 选择 adapter：
        //   - from=slide:N... → PptAdapter
        //   - from=sheet:Name... 或 Name!A1 → XlsxAdapter
        //   - args.path 指向代码/文本文件（无 .hdoc/.docx）→ CodeAdapter
        //   - args.tabId 或活动标签是 aiview://document-editor → DocumentAdapter
        //   - 活动标签是 resource://xxx.{pptx,xlsx} → 对应 PPT/XLSX adapter
        //   - 活动标签是 resource://xxx.{code/txt/...} → CodeAdapter（推断 path）
        //   - 否则 → V1BridgeAdapter（兜底）
        _pick(args) {
            // 1. 路径式语法优先
            const from = args && args.from;
            if (typeof from === 'string') {
                if (/^slide:\d+/i.test(from)) return this._ppt;
                if (/^sheet:/i.test(from) || /^[^\s!]+![A-Za-z]+\d+/.test(from)) return this._xlsx;
            }
            // 2. 显式 path
            const path = args && args.path;
            if (path) {
                const lower = String(path).toLowerCase();
                if (/\.pptx$/.test(lower)) return this._ppt;
                if (/\.xlsx$/.test(lower)) return this._xlsx;
                if (/\.(hdoc|docx)$/.test(lower)) return this._doc;
                return this._code;
            }
            // 3. 活动标签类型
            const ed = global.editorSkill;
            if (ed && typeof ed._findEditorTab === 'function') {
                try {
                    const info = ed._findEditorTab();
                    if (info?.viewerType === 'ppt') return this._ppt;
                    if (info?.viewerType === 'xlsx') return this._xlsx;
                } catch (_) { /* ignore */ }
            }
            const tm = global.tabManager;
            const t = tm?.getActiveTab?.();
            const url = String(t?.url || '');
            if (/^aiview:\/\//.test(url)) return this._doc;
            // resource://path 形式：当作物理文件
            const resMatch = url.match(/^resource:\/\/file\/(.+)$/i);
            if (resMatch) {
                const inferred = decodeURIComponent(resMatch[1]).split(/[?#]/)[0];
                const lower = inferred.toLowerCase();
                if (/\.pptx$/.test(lower)) return this._ppt;
                if (/\.xlsx$/.test(lower)) return this._xlsx;
                if (/\.(hdoc|docx)$/.test(lower)) {
                    args.path = inferred; // 让 DocumentAdapter 通过 path 反查
                    return this._doc;
                }
                args.path = inferred;
                return this._code;
            }
            return this._v1;
        }

        _snapshotDocument(args) {
            const normalized = { ...(args || {}) };
            if (this._pick(normalized) !== this._doc) return null;
            const viewer = this._doc._viewer(normalized);
            if (!viewer) return null;
            return { viewer, paragraphs: viewer.getParagraphs() || [] };
        }

        _bindStableDocumentRefs(args, paragraphs) {
            const type = _normalizeEditType(args.type);
            const shouldBind = new Set(['replace', 'insert', 'insert-after', 'insertafter', 'delete']);
            if (!shouldBind.has(type)) return { ...(args || {}) };
            const bindRef = (ref) => {
                if (ref == null || ref === '') return ref;
                if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
                    const n = Math.max(1, Math.min(paragraphs.length, parseInt(ref, 10)));
                    const id = paragraphs[n - 1]?.id;
                    return id ? `id:${id}` : ref;
                }
                return ref;
            };
            const next = { ...(args || {}) };
            if (next.from != null && next.from !== '') next.from = bindRef(next.from);
            if (next.to != null && next.to !== '') next.to = bindRef(next.to);
            if (typeof next.at === 'string') {
                const m = next.at.match(/^line:(\d+)$/i);
                if (m) {
                    next.from = bindRef(m[1]);
                    delete next.at;
                }
            }
            return next;
        }

        normalizeBatchInvocations(invocations) {
            if (!Array.isArray(invocations) || invocations.length < 2) return invocations;
            const snapshots = new Map();
            const readLockedViewers = new Set();
            let lastExplicitCodePath = '';
            return invocations.map((inv) => {
                if (!inv) return inv;
                if (inv.manifestId === 'read') {
                    const readArgs = { ...(inv.args || {}) };
                    const mode = String(readArgs.mode || (String(inv.fence || '').toLowerCase() === 'file-read' ? 'file' : '')).toLowerCase();
                    if (mode === 'file' && typeof readArgs.path === 'string' && readArgs.path.trim()) {
                        lastExplicitCodePath = readArgs.path;
                    }
                    return inv;
                }
                if (inv.manifestId !== 'edit') return inv;
                const args = _normalizeSpanArgs(_normalizeAnchorArgs(inv.args || {}));
                if ((!args.path || !String(args.path).trim()) && lastExplicitCodePath) {
                    args.path = lastExplicitCodePath;
                    args._inheritedPath = true;
                }
                if (typeof args.path === 'string' && args.path.trim() && !/\.(hdoc|docx)$/i.test(args.path)) {
                    lastExplicitCodePath = args.path;
                }
                const snap = this._snapshotDocument(args);
                if (!snap) return { ...inv, args };
                const cached = snapshots.get(snap.viewer) || snap.paragraphs;
                if (!snapshots.has(snap.viewer)) snapshots.set(snap.viewer, cached);
                const normalizedArgs = this._bindStableDocumentRefs(args, cached);
                const type = _normalizeEditType(normalizedArgs.type);
                if (type === 'read') {
                    readLockedViewers.add(snap.viewer);
                    return { ...inv, args: normalizedArgs };
                }
                if (readLockedViewers.has(snap.viewer)) {
                    return { ...inv, args: { ...normalizedArgs, _batchReadConflict: true } };
                }
                return { ...inv, args: normalizedArgs };
            });
        }

        async execute(args) {
            args = _normalizeSpanArgs(_normalizeAnchorArgs(args));
            if (args._anchorConflict) return { success: false, error: 'edit: before 和 after 不能同时出现；请选择一个锚点' };
            if (args._batchReadConflict) return { success: false, error: 'edit: 文档 read 与 edit 不能放在同一回复。请先单独发送 read，等系统返回最新行号后，再发送 edit。' };
            const type = String(args.type || '').toLowerCase();
            // 兼容旧 at: "start|end|line:N"
            if (args.at && (args.from == null)) {
                const at = String(args.at).toLowerCase();
                if (at === 'start' || at === 'begin') args = { ...args, from: 1, _atKind: 'before' };
                else if (at === 'end') args = { ...args, _atKind: 'end' };
                else {
                    const m = at.match(/^line:(\d+)$/);
                    if (m) args = { ...args, from: parseInt(m[1], 10), _atKind: 'before' };
                }
            }
            // _pick 可能向 args 注入 path（resource://xxx 推断）
            args = { ...args };
            const adapter = this._pick(args);
            switch (type) {
                case 'read': return adapter.read(args);
                case 'replace': return adapter.replace(args);
                case 'insert':
                    // at:"end" → insertAfter 末尾
                    if (args._atKind === 'end') return adapter.insertAfter({ ...args, from: undefined });
                    return adapter.insert(args);
                case 'insertafter': case 'insert_after': case 'insert-after': return adapter.insertAfter(args);
                case 'delete': return adapter.delete_(args);
                case 'findreplace': case 'find-replace': case 'find_replace': return adapter.findReplace(args);
                case 'setcontent': case 'set-content': case 'set_content': return adapter.setContent(args);
                case 'regenerate': case 'regen': case 'rebuild':
                    if (typeof adapter.regenerate !== 'function') return { success: false, error: 'regenerate 仅支持 PPT' };
                    return adapter.regenerate(args);
                default: return { success: false, error: `edit: unknown type "${args.type}"`, hint: '支持: read / replace / insert / insertAfter / delete / find-replace / set-content / regenerate' };
            }
        }
    }

    const exports_ = { LineEditAdapter, CodeAdapter, DocumentAdapter, V1BridgeAdapter, PptAdapter, XlsxAdapter, _resolveParaRef };
    if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        Object.assign(global.AgentV2, exports_);
    }
})(typeof window !== 'undefined' ? window : globalThis);
