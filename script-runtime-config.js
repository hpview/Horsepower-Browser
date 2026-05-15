/**
 * Phase D · ScriptRuntimeConfig
 *
 * 集中所有 Phase D 可调参数。修改这里即可调整：
 *   - 沙箱超时
 *   - API 表面（白名单）
 *   - 系统提示中 L1 显示阈值
 *   - 元-skill 自举触发关键词
 *
 * 设计原则：所有"魔法数字"和"白名单"集中在此文件，方便后续打开"高级设置"面板时绑定为可视化配置。
 */

(function (global) {
    'use strict';

    const ScriptRuntimeConfig = {
        version: 1,

        /** 沙箱执行 */
        sandbox: {
            /** 单次脚本执行硬超时（毫秒） */
            timeoutMs: 30 * 1000,
            /** 默认 target（renderer | webview | main） */
            defaultTarget: 'renderer',
            /** 允许的 target */
            allowedTargets: ['renderer', 'webview', 'main'],
            /** logs 缓冲条数上限（防止脚本暴 console） */
            maxLogLines: 200,
            /** 单条 log 字符上限 */
            maxLogChars: 2000,
            /** 返回值序列化字符上限（超出后截断 + 标记） */
            maxResultChars: 50 * 1024,
        },

        /** API 表面白名单 —— 注入到沙箱 globalThis.api 上 */
        apiSurface: {
            files: ['readFile', 'writeFile', 'readDir', 'stat'],
            workbench: ['createEmptyPptx', 'createEmptyXlsx', 'resolveDefaultPath', 'scaffoldProject'],
            tabs: ['list', 'getActive'],
            mcp: ['callToolByName', 'getToolDefinitions'],
            skills: ['list', 'get', 'save', 'delete', 'export', 'import'],
            // util / paths 内置由 runtime 直接生成，不走 IPC
            util: ['sleep', 'uuid', 'hash'],
            paths: ['userData', 'workspace', 'skillData', 'resolve', 'join'],
        },

        /** 路径解析（沙箱内 api.paths.* 的语义） */
        paths: {
            /** 相对路径默认根：'workspace' | 'userData' | 'skillData' */
            relativeBase: 'workspace',
            /** 是否允许脚本写绝对路径（默认允许，仅 docs 警告） */
            allowAbsolute: true,
            /** skillData 目录名（在 userData/aiview-data/ 下） */
            skillDataSubdir: 'skill-data',
        },

        /** main 沙箱（target:'main'）—— 通过 vm 模块 + 白名单 require 让脚本调用 npm 包 */
        mainSandbox: {
            enabled: true,
            /** 白名单 require —— 仅这些 module 可被 require() */
            allowedModules: [
                'pptxgenjs', 'exceljs', 'jszip',
                'fs', 'fs/promises', 'path', 'os', 'crypto', 'util',
                'buffer', 'stream',
            ],
            /** 注入到 main 沙箱的 globals（除标准 ECMAScript） */
            globals: ['Buffer', 'console', 'process'],
            /** 限制 process 可见字段（防止 process.exit 等） */
            processWhitelist: ['platform', 'arch', 'version', 'cwd', 'env'],
        },

        /** Skill 列表披露（context-composer L1） */
        disclosure: {
            /** 始终显示的 user skill 名字（一行） */
            l1AlwaysShow: true,
            /** L1 列表超过 N 条时折叠 */
            l1FoldThreshold: 20,
            /** L2（提到关键词时披露 description+签名）匹配模糊度 */
            l2FuzzyMatch: true,
            /** L3 = 失败重试时注入完整 code（已沿用 _retainSpecs 机制） */
            l3OnFailure: true,
        },

        /** Meta-skill 自举（"可保存为 skill"提示）触发条件 */
        metaSkillHint: {
            /** 用户消息匹配关键词 */
            userKeywords: [
                '保存', '另存', '记下来', '下次还能用', '创建技能',
                '保存为 skill', '存成脚本', '注册脚本',
                'save as skill', 'save this script', 'register skill', 'remember this',
            ],
            /** 上一轮 script 调用 success → 下一轮提示可保存 */
            promptAfterSuccess: true,
            /** TTL：触发后注入提示的轮数 */
            ttl: 1,
            /** 严格关键词：命中后才在 L1 显示 meta-skill 详细签名（默认隐藏） */
            strictKeywords: [
                '保存技能', '创建skill', 'createSkill', '注册脚本', '沉淀技能',
                '保存为skill', 'save skill', 'create skill', 'register script',
            ],
            /** meta-skill 的固定 id（builtin） */
            metaSkillId: 'meta-skill',
        },

        /** 审计日志 */
        audit: {
            enabled: true,
            /** 日志文件相对 userData/aiview-data 的路径 */
            relPath: 'skill-audit.log',
            /** 保留天数（0 = 永久） */
            retentionDays: 30,
        },
    };

    if (global) {
        global.AgentV2 = global.AgentV2 || {};
        global.AgentV2.ScriptRuntimeConfig = ScriptRuntimeConfig;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = ScriptRuntimeConfig;
})(typeof window !== 'undefined' ? window : globalThis);
