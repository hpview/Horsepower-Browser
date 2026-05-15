/**
 * Phase D · script manifest
 *
 * 唯一对外暴露的 JS 执行入口。AI 可：
 *   1. 临时执行 ad-hoc 代码：`script {code: "...", args:{...}}`
 *   2. 调用已注册的 skill 脚本：`script {name:"skill-id.script-name", args:{...}}`
 *   3. 在网页上下文执行：`script {code:"...", target:"webview"}`
 *
 * 系统提示三级披露：
 *   L1：始终展示 user skill 列表（context-composer 单独处理）
 *   L2：用户/AI 提到 skill 名 → fullSpec 输出该 skill 的描述+签名
 *   L3：执行失败 → 通过 _retainSpecs 注入完整 code（context-composer 标准机制）
 */

(function (global) {
    'use strict';

    const manifest = {
        id: 'script',
        title: 'JavaScript 执行',
        tier: 1,
        fences: ['script'],

        coreDescription: [
            '执行 JavaScript（沙箱）。三种调用：',
            '```script',
            '{"code":"return 1+1","args":{}}                                // renderer 沙箱',
            '{"target":"main","code":"const P=require(\'pptxgenjs\'); ..."}  // main 沙箱：可 require pptxgenjs/exceljs/jszip/fs/path',
            '{"name":"skill-id.fn","args":{...}}                             // 调已注册 skill',
            '```',
            '注入：`api.files / workbench / tabs / mcp / skills / paths / util`；返回值需 JSON 可序列化；30s 超时。',
        ].join('\n'),

        fullSpec: [
            '## script — 详细约定',
            '',
            '### 调用形态',
            '- `{ code: "return await api.files.readDir(\'.\');" }`   立即执行',
            '- `{ name: "csv-to-pptx.main", args: { csvPath:"..." } }` 调用已注册脚本',
            '- `{ code: "...", target: "webview" }`                   在 webview 内执行',
            '',
            '### 注入到 globalThis 的对象',
            '- **api.files**: readFile(path, enc?), writeFile(path, content, enc?), readDir(path), stat(path)',
            '- **api.workbench**: createEmptyPptx({path,title,slides[]}), createEmptyXlsx(path), resolveDefaultPath({category,ext,baseName}), scaffoldProject(type,dir)',
            '- **api.tabs**: list(), getActive()',
            '- **api.mcp**: callToolByName(toolName, args), getToolDefinitions()',
            '- **api.skills**: list(), get(id), save(skill), delete(id), export(id,destPath), import(srcPath,opts)',
            '- **api.paths**: userData(...sub), skillData(...sub), workspace(...sub), resolve(path), join(...parts)',
            '- **api.util**: sleep(ms), uuid(), hash(str) → SHA-256 hex',
            '',
            '### 安全限制',
            '- 30 秒硬超时；返回值 50 KB 上限',
            '- renderer/webview 不可访问 require/process/electronAPI/eval/Function',
            '- target=`main` 时仅允许 `require()` 白名单模块（如 pptxgenjs/exceljs/jszip/fs/path）',
            '- args 必须是 JSON-serializable',
            '',
            '### 推荐流程：写 → 测 → 保存',
            '1. 临时 `{code:"..."}` 调试',
            '2. 成功后用 `{name:"meta-skill.create", args:{id, name, scripts:[{name,params,returns,code}]}}` 保存',
            '3. 后续会话用 `{name:"<id>.<scriptName>"}` 直接调用',
        ].join('\n'),

        intentKeywords: [
            '脚本', 'JS', 'js', 'script', '执行', '运行', 'eval', '函数', '保存技能', 'skill',
            'pptxgenjs', 'PptxGenJS', 'exceljs', 'ExcelJS', 'jszip', 'JSZip',
            '用代码', '用 js', '用js', '编程生成', '直接生成', 'require', '写脚本',
        ],

        intentConfig: {
            keywords: ['脚本', 'script', '执行', '运行', 'pptxgenjs', 'exceljs', 'jszip', 'require', '编程生成', '写脚本'],
            contextHints: { editor: [], browser: [], tabs: [] },
            baseScore: 0.55,
        },

        toolSchema: {
            name: 'script',
            description: '在沙箱中执行 JavaScript（renderer / webview）；可临时执行或调用已注册 skill',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: '脚本源码（async 函数体）；与 name 二选一或并存' },
                    name: { type: 'string', description: '已注册 skill 脚本：skillId.scriptName' },
                    args: { type: 'object', description: '入参对象，注入为 globalThis.args' },
                    target: { type: 'string', enum: ['renderer', 'webview', 'main'], description: '执行目标，默认 renderer' },
                },
                required: [],
            },
        },

        examples: [
            { user: '读出工作目录下所有 .txt 文件', invocation: { code: 'const r = await api.files.readDir("."); return r.items.filter(i=>i.name.endsWith(".txt"));' } },
            { user: '把这个脚本保存成 skill 叫 list-txt', invocation: { name: 'meta-skill.create', args: { id: 'list-txt', name: '列出 txt', scripts: [{ name: 'main', code: 'return await api.files.readDir(".");' }] } } },
        ],

        /**
         * 工具执行入口：dispatcher 会调用 manifest.execute(args, ctx)
         */
        async execute(args /*, ctx */) {
            const runtime = global.AgentV2?.ScriptRuntime;
            const registry = global.AgentV2?.skillRegistry;
            if (!runtime) return { success: false, error: 'ScriptRuntime 未就绪' };

            // 解析 name → 拉 code
            if (args?.name && !args?.code && registry) {
                const r = await registry.resolveScript(args.name);
                if (r.error) return { success: false, error: r.error };
                if (r.mcp) {
                    // MCP skill：直接转发
                    const api = global.electronAPI?.mcp;
                    if (!api?.callToolByName) return { success: false, error: 'mcp.callToolByName 不可用' };
                    try {
                        const out = await api.callToolByName(r.mcp.toolName, args.args || {});
                        return { success: true, result: out, skillId: r.skill.id, scriptName: r.script.name, kind: 'mcp' };
                    } catch (e) { return { success: false, error: e?.message || String(e) }; }
                }
                args = { ...args, code: r.codeText };
            } else if (args?.name && args?.code) {
                // 同时给：code 覆盖（用于调试），但不持久化
            }

            const result = await runtime.execute(args || {});

            // 自举提示：成功且非 meta-skill 自身 → 标记下一轮可提示
            try {
                if (result?.success && global.aiChatManager) {
                    global.aiChatManager._v2DiscoveredFlags = Object.assign({},
                        global.aiChatManager._v2DiscoveredFlags || {},
                        { scriptLastSuccess: 1 });
                }
            } catch (_) { /* ignore */ }

            return result;
        },
    };

    if (global.AgentV2 && global.AgentV2.registerManifest) {
        global.AgentV2.registerManifest(manifest);
    } else {
        // 暂存：boot 阶段会消化
        global.AgentV2 = global.AgentV2 || {};
        global.AgentV2._pendingManifests = global.AgentV2._pendingManifests || [];
        global.AgentV2._pendingManifests.push(manifest);
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
