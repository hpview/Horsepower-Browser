<div align="center">

# Horsepower 马上浏览

### 系统级 AI 统一工作台

浏览器 · 办公套件 · 终端 · 文件管理器 · 代码编辑器 · AI 智能体 — 融为一体

[![Release](https://img.shields.io/badge/version-v1.0.0-4f46e5?style=flat-square)](https://github.com/hpview/Horsepower-Browser/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-78716c?style=flat-square)]()

</div>

---

## 我们在解决什么问题

知识工作者面临的核心矛盾：**工具太多、太散**。浏览器开着二十个标签，文档编辑器、代码编辑器、终端、各类 AI 对话框分散在不同应用——每一次上下文切换都意味着注意力中断和信息流失。

即便是最先进的 AI 助手，也只是"又一个需要手动切换过去的应用"——能回答问题但不能打开文件，能生成报告但不能保存到正确位置。**AI 的能力边界终结于对话框。** Horsepower 要打破的，正是这堵墙。

---

## 六大核心创新

| # | 创新点 | 说明 |
|---|--------|------|
| 1 | **AI 多模态全流程引擎** | 八大技能系统——操控浏览器、终端、文件系统、办公套件，全程执行 |
| 2 | **自研办公引擎** | 文档/PPT/表格引擎完全自研，与 Office 高度兼容，AI 可端到端自动化 |
| 3 | **创新主页与搜索系统** | 60+ 搜索引擎 + AI 引擎 + 小组件侧边栏，Ctrl+Enter 多引擎并行搜索 |
| 4 | **自研多窗口分屏引擎** | 超越 Edge 分屏，灵活布局 + 最多 3 个独立 AI 子窗口 |
| 5 | **端侧多模态原生调用** | C# WinRT 原生 OCR/语音/TTS，端侧零延迟，数据不出设备 |
| 6 | **零配置消息桥接** | 登录即接入微信/飞书/WhatsApp/Discord，笔记本化身 24h AI 服务器 |

---

## 自研办公引擎

> 不依赖 Office 或 Google Docs。本地运行，AI 可端到端自动化操控。

### 📄 文档编辑器（BlockEngine）

自研图文混排引擎，12 列栅格 + 4 种布局模式。25+ 编辑操作，浮动工具栏选中即触发。

- HDOC 原生格式（JSON v1 / ZIP v2），12 版本历史
- 导出 Word (.docx) / PDF / HTML / Markdown
- AI 可控制格式、插入内容、调整排版

### 📊 演示文稿编辑器（OOXML）

查看/编辑/演示三种模式，16:9 和 4:3。自研 OOXML 解析器，与 Office 高度兼容。

- 文本/形状/图像/表格/背景完整解析
- PPTX 标准格式 + HPPT 原生格式（百分比坐标，分辨率无关）

### 📈 电子表格引擎（纯 SVG）

多工作表、合并/冻结/排序/筛选、公式栏。6 种图表（柱状/条形/折线/面积/饼图/散点），纯手写 SVG 渲染——零外部图表依赖。最大 5000 行 × 200 列实时渲染。XLSX 标准格式导出。

---

## 八大 AI 技能系统

技能共享同一上下文——AI 可在一次会话中"打开网页 → 提取表格 → 写入表格 → 生成图表 → 嵌入文档 → 导出 Word"。

| 技能 | 能力 |
|------|------|
| **BrowserSkill** | 浏览器操控 · 搜索 · 标签组 · 分屏 |
| **TerminalSkill** | PowerShell / Bash + 安全沙箱 |
| **FileSkill** | 文件读写 · 创建 · 搜索 · 导航 |
| **WebpageSkill** | HTML/CSS/JS 实时生成 |
| **EditorSkill** | Monaco + 自研办公引擎联动 |
| **MemoSkill** | 待办 / 日程 / 笔记 / 定时 |
| **SubAgentSkill** | 最多 20 个子智能体并行 |
| **Autocomplete** | AI Diff 追踪 + 变更管理 |

### MCP 开放协议

零外部依赖，纯 JSON-RPC 2.0。stdio + HTTP 双传输。兼容 Claude Desktop / Cursor / VS Code 配置格式，一键导入社区工具服务器。

### 适配性引导设计

渐进式披露——端侧轻量模型看精简指令集，云端大模型获完整能力描述。模型无关兼容，从 7B 到百亿级均可驱动。

---

## 竞品对比

> ★★★★★ 极强 / ★★★★☆ 强 / ★★★☆☆ 中等 / ★★☆☆☆ 弱 / — 不具备

| 能力 | **Horsepower** | ChatGPT | Cursor | Manus | Copilot(M365) |
|------|:---:|:---:|:---:|:---:|:---:|
| AI 对话 | ★★★★☆ | ★★★★★ | ★★★★☆ | ★★★★☆ | ★★★★☆ |
| 浏览器操控 | **★★★★★** | ★★★☆☆ | — | ★★★★★ | — |
| 终端命令 | **★★★★☆** | — | ★★★★★ | ★★★★☆ | — |
| 文件读写 | **★★★★★** | ★☆☆☆☆ | ★★★★☆ | ★★★★☆ | ★★☆☆☆ |
| 子Agent并行 | **★★★★★** | — | — | ★★★★☆ | — |
| 端侧离线 | **★★★★★** | — | — | — | — |
| 数据不出设备 | **★★★★★** | — | — | — | ★☆☆☆☆ |
| OCR/STT | **★★★★☆** | ★★★★☆ | — | — | ★★☆☆☆ |
| 办公引擎 | **★★★★☆** | ★★☆☆☆ | — | — | ★★★★★ |
| 搜索引擎集成 | **★★★★★** | ★★☆☆☆ | — | — | — |
| 消息桥接 | **★★★★★** | — | — | — | — |
| MCP 协议 | **★★★★★** | — | ★★★★★ | — | — |
| 本地工具站 | **★★★★★** | — | — | — | — |

---

## 应用场景

**📚 研究者：一键知识整合**
> "搜集近三年大语言模型幻觉问题的研究，整理成文献综述初稿。"AI 并行打开学术数据库、提取摘要与结论、写入文档编辑器、生成带章节初稿。

**✍️ 内容创作者：多源工作台**
> RSS 资讯同步 → AI 多源提取热点 → 生成选题简报 → 起草框架 → 实时润色 → 全程一个窗口完成。

**💼 职场新人：AI 辅助成长**
> multi-search 多源提取竞品信息 → AI 生成对比表格 → 数据可视化 → 自动生成 PPT 骨架 → 填充结论一键导出。

**🔐 端侧隐私办公**
> 端侧 LLM 驱动分析，数据不上传。WinRT OCR 端侧识别扫描件，SAPI 离线转写录音。断网全部 Agent 技能可工作。

**📱 消息桥接：24h AI 服务器**
> 微信发"查下周末高铁票价" → 笔记本 AI 自动搜索整理回传。笔记本 = 24h 个人 AI 服务器。

---

## 安全架构

| 层级 | 防护 |
|------|------|
| 内核 | Electron Fuses 编译期锁定，ASAR 完整性验证，Ed25519 C++ 原生签名验证（Native Guard），防调试 |
| 数据 | AES-256-GCM 本地密码存储，Session 级路径授权 + realpath 防符号链接绕过 |
| 内容 | SVG 消毒处理，MCP 命令注入防护，Chrome 扩展 30+ 权限中文翻译 + 高危权限拦截 |

---

## 产品信息

| 项目 | 内容 |
|------|------|
| 版本 | v1.0.0 |
| 技术栈 | Electron + Chromium + Node.js + C# (WinRT) |
| 安装包 | ~120 MB |
| 安装后 | ~500 MB |
| 运行内存 | ~290 MB |
| 平台 | Windows / macOS / Linux |
| 免安装 | 支持 Portable |
| 价格 | 免费 |
| 联系 | hku1@qq.com |

---

## 快速开始

```bash
# 从 GitHub Releases 下载最新版
# https://github.com/hpview/Horsepower-Browser/releases

# 或克隆源码本地构建
git clone https://github.com/hpview/Horsepower-Browser.git
cd Horsepower-Browser
npm install
npm start
```

---

<div align="center">


[下载](https://github.com/hpview/Horsepower-Browser/releases) · [源码](https://github.com/hpview/Horsepower-Browser) · [反馈](https://github.com/hpview/Horsepower-Browser/issues)

</div>
