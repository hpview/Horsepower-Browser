/**
 * V2 manifest — browser
 * Tier-1：浏览器自动化（高容错，所有参数可省略）
 *
 * 设计：
 *   - 一阶段（始终披露 oneline）：open / switchTab / navigate / getStructure
 *   - 二阶段（getStructure 成功后披露 stage2Spec）：fillField / selectOption / click / pressKey / injectJS / extract
 *   - 全部由 NativeExecutor 直接走 webview / tabManager，无 V1 桥接
 */
(function (global) {
    const stage2Spec = [
        '## browser 二阶段（已抽取过页面结构后可用）',
        '前置条件：本轮或上轮必须先用 `{"action":"getStructure"}` 拿到页面结构（节点列表 + buttons/links/texts 分类），',
        '再针对 selector / idx / text / id 调用以下动作。',
        '',
        '- `{"action":"fillField","selector":"#email","value":"a@b.com"}` — 填充 input/textarea/contenteditable（遇到 anchor/role=radio/checkbox/button 会自动 click退化）',
        '- `{"action":"fillField","idx":7,"value":"..."}` — 也可用 getStructure 返回的 `idx` 代替 selector，避免超长 CSS 选择器',
        '- `{"action":"selectOption","selector":"#country","value":"CN"}` — 选下拉项；value 可换成 label',
        '- `{"action":"click","selector":".submit"}`、`{"action":"click","idx":12}`、`{"action":"click","text":"提交"}`、`{"action":"click","title":"点赞（Q）"}`、`{"action":"click","shortcut":"Q"}`、`{"action":"click","id":"submit_button"}` — 可按选择器、idx、按钮/链接文字、title/热键或 DOM id 点击',
        '- `{"action":"pressKey","key":"Enter"}` 或 `{"action":"pressKey","key":"Enter","selector":"input.search"}` — 模拟键盘操作；常见提交/搜索优先用 Enter',
        '- `{"action":"injectJS","code":"document.title"}` — 在当前 webview 注入 JS，返回 JSON 序列化结果',
        '- `{"action":"extract","selector":"main"}` — 抽取节点文本/HTML（默认 4000 字符截断）',
        '- `{"action":"scroll","y":800}` — 滚动到指定 y / "bottom" / "top"',
        '',
        '### 多步执行（原生支持，无需额外动作名）',
        '在同一个 `《browser》` 代码块内，下面任一写法均有效，会顺序执行并逐项报告：',
        '1) 数组形式：',
        '   ```browser',
        '   [',
        '     {"action":"click","selector":"..."},',
        '     {"action":"fillField","selector":"#q3","value":"1500"}',
        '   ]',
        '   ```',
        '2) 多个 JSON 对象连写（不需逗号不需数组）：',
        '   ```browser',
        '   {"action":"click","selector":"..."}',
        '   {"action":"fillField","selector":"#q3","value":"1500"}',
        '   ```',
        '外层 `success` 仅在全部成功时为 true；step 可设 `stopOnError:true` 遇错提前中断。',
        '单步调用仍然是原来的单个 JSON 对象，返回也是原始单个结果。',
        '',
        '### 填写表单的建议流程',
        '1. `getStructure` 拿全部表单项（如需更多节点 limit 调高，默认 60）',
        '2. 逐项检查是否遗漏（必须覆盖返回中所有必填项，不要仅依赖例子中的 1–8 题）',
        '3. 表单批量填写可以合并为一次 `batch`；但可能跳页/开新页的按钮点击建议单步执行，因为返回结果会附带新页面摘要',
        '',
        '所有 selector 支持 CSS 选择器；省略时会优先用 idx、按钮文字、title、shortcut、id 匹配页面元素。',
        '执行失败请重试 getStructure 重新读取页面（页面可能已更新）。',
    ].join('\n');

    const manifest = {
        id: 'browser',
        version: '1.0.0',
        tier: 1,
        title: '浏览器操作',
        icon: 'compass',
        color: '#0ea5e9',
        fences: ['browser'],
        nativeOnly: true,

        // 二阶段披露文本（context-composer 在 flags.browserStage2=true 时拼接）
        stage2Spec,

        coreDescription: [
            '```browser',
            '{ "action": "getStructure" }',
            '```',
            '→ 操作浏览器：所有参数都可省，常用 action（一阶段，无需先抽结构）：',
            '- `open` 打开 URL：`{"action":"open","url":"..."}`（省略 url 则切到主页）',
            '- `switchTab` 切到已有标签：`{"action":"switchTab","id":<id>}` 或 `{"action":"switchTab","title":"片段"}`',
            '- `navigate` 当前标签跳转：`{"action":"navigate","url":"..."}`',
            '- `getStructure` 抽取当前页面结构（返回 `nodes + buttons + links + texts`，拿到 selector/idx/文字/id/title/shortcut 后再用 `fillField`/`click`/`pressKey`/`injectJS` 等二阶段动作）',
            '没有当前活动网页时，所有 action 会返回提示，不会抛错。',
        ].join('\n'),

        fullSpec: [
            '## browser — 一阶段（始终可用）',
            '- `open` 打开新标签：`{"action":"open","url":"..."}`',
            '- `switchTab` 切换：`{"action":"switchTab","id":?,"title":?}`（id 优先，否则按标题模糊匹配）',
            '- `navigate` 当前标签跳转：`{"action":"navigate","url":"..."}`',
            '- `getStructure` 当前页结构：`{"action":"getStructure","limit":200}`',
            '  → 返回 `{ count, nodes, buttons, links, texts }`。`nodes` 是完整交互节点；`buttons/links/texts` 是按页面文字分类后的轻量视图。每个节点都可能带 `label/title/shortcut/className/q`。`role` 为 `radio|checkbox|input|textarea|select|button|link`。已过滤隐藏元素与空文本节点。',
            '- `closeTab` 关闭：`{"action":"closeTab","id":?}`（省略 id 则关当前）',
            '- `getTabs` 列出所有标签：`{"action":"getTabs"}`',
            '',
            '## 二阶段（建议先 getStructure 拿到 selector 再调用）',
            '- `fillField` 填表单：`{"action":"fillField","selector":"...","value":"..."}` 或 `{"action":"fillField","idx":<idx>,"value":"..."}`',
            '- `selectOption` 选选项：`{"action":"selectOption","selector":"...","value":"..."}`',
            '- `click` 点击：`{"action":"click","selector":"..."}`、`{"action":"click","idx":<idx>}`、`{"action":"click","text":"搜索"}`、`{"action":"click","title":"点赞（Q）"}`、`{"action":"click","shortcut":"Q"}`、`{"action":"click","id":"submit"}`、`{"action":"click","href":"github.com"}`、`{"action":"click","q":"是否提交"}`',
            '- `pressKey` 键盘：`{"action":"pressKey","key":"Enter"}`、`{"action":"pressKey","key":"Enter","selector":"input.search"}`、`{"action":"pressKey","key":"Escape"}`',
            '- `injectJS` 注入：`{"action":"injectJS","code":"..."}`（返回 JSON.stringify 后的值）',
            '- `extract` 抽取：`{"action":"extract","selector":"main","format":"text|html"}`',
            '- `scroll` 滚动：`{"action":"scroll","y":<number|"top"|"bottom">}`',
            '',
            '## 多步执行（原生）',
            '同一个 `《browser》` 代码块内可以：',
            '- 使用数组 `[ {step1}, {step2} ]`',
            '- 或连着写多个 JSON 对象（无需逗号，无需数组）',
            '系统顺序执行并返回每步成败状态；step 可设 `stopOnError:true`。',
            '',
            '提示：',
            '- 所有字段都可省略；缺参数时给出友好回退；selector 找不到时返回 `{success:false,error:...}` 不抛异常。',
            '- 填表场景请**先 getStructure 读全部题目**（limit 可调高到 80~120），避免遗漏必填题。',
            '- 表单内多个点击/填写可合并为一个 `batch` 调用；涉及跳页、打开新标签、提交表单、搜索回车时优先单步执行，因为结果会自动附带页面变化和更新后的结构摘要。',
        ].join('\n'),

        intentKeywords: ['浏览', '网页', '点击', 'click', '填写', '表单', 'form', '输入框', '搜索框', '注入', 'inject', 'js', '页面结构', '导航', 'navigate', '打开网址', 'url', '回车', 'enter', '快捷键', '键盘', '点赞', '评论'],

        intentConfig: {
            keywords: ['浏览', '网页', '点击', 'click', '填写', '填表', '表单', 'form', '输入框', '注入', 'inject', '页面结构', 'getstructure', '导航', 'navigate', '打开', '搜索框', '下拉', 'option', '选项', '回车', 'enter', '快捷键', '键盘', '点赞', '评论'],
            contextHints: {
                editor: [],
                browser: ['http://', 'https://'],
                tabs: ['webpage'],
            },
            baseScore: 1.0,
        },

        toolSchema: {
            name: 'browser',
            description: '浏览器自动化：open/switchTab/navigate/getStructure/fillField/selectOption/click/pressKey/injectJS/extract/scroll',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: '动作名' },
                    url: { type: 'string' },
                    id: { description: 'tab id 或 DOM id' },
                    title: { type: 'string' },
                    selector: { type: 'string' },
                    idx: { type: 'number', description: 'getStructure 返回的 idx，代替 selector' },
                    text: { type: 'string', description: '按钮/链接可见文字' },
                    label: { type: 'string', description: '控件标签文字' },
                    shortcut: { type: 'string', description: 'title 中出现的快捷键，如 Q/W/E/Enter' },
                    href: { type: 'string', description: '链接 href 片段' },
                    q: { type: 'string', description: '题干或邻近问题文本' },
                    key: { type: 'string', description: '要模拟的按键，如 Enter/Escape/Tab/Q' },
                    value: { type: 'string' },
                    code: { type: 'string' },
                    format: { type: 'string' },
                    limit: { type: 'number' },
                    y: {},
                },
            },
        },
    };

    if (global.AgentV2 && global.AgentV2.registerManifest) global.AgentV2.registerManifest(manifest);
    if (typeof module !== 'undefined' && module.exports) module.exports = manifest;
})(typeof window !== 'undefined' ? window : globalThis);
