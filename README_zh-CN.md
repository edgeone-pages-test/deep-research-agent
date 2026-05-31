# 深度研究 Agent

基于 EdgeOne Makers 平台的多智能体深度研究助手。支持人机协作确认子问题、实时网页与学术搜索、自动续写报告生成、项目版本管理。

## 功能特性

- **两阶段研究流程** — AI 分解问题 → 用户确认/编辑子问题 → 开始正式研究
- **真实网页搜索** — 内置 `web_search` 工具（首选）+ Bing/DuckDuckGo（降级）
- **真实学术搜索** — CrossRef API + Semantic Scholar，返回结构化论文数据
- **自动续写** — 模型输出被截断时，自动重试最多 15 次直到报告完整
- **结构检查** — 生成后自动移除重复章节、修复格式问题
- **增量编辑** — 继续研究时保留原有报告结构，仅修改用户要求的部分
- **项目与版本管理** — 创建项目、自动保存版本、版本对比
- **继续研究对话** — 对话式界面讨论报告、建议修改、添加文献（聊天记录持久化到 Blob）
- **文献管理** — AI 检测到用户提及新论文时，自动建议添加到左侧论文列表
- **实时流式输出** — SSE 推送各阶段进度
- **URL 抓取** — 抓取用户提供的 URL 内容并整合进研究
- **中英双语** — 支持中文和英文界面
- **深色模式** — 完整支持
- **固定侧边栏** — 项目列表固定显示，不随主内容滚动

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js + React 19 (App Router) |
| 样式 | Tailwind CSS |
| Agent 框架 | OpenAI Agents SDK (`@openai/agents`) |
| 大模型 | `@makers/deepseek-v4-flash`（写死）通过 EdgeOne AI Gateway |
| 平台 | EdgeOne Makers（云函数、Blob 存储、沙箱、Tools） |
| 网页搜索 | `context.tools.get('web_search')` 内置工具 |
| Markdown 渲染 | react-markdown + remark-gfm（表格、删除线） |

## 架构

```
┌─────────── 前端 (Next.js) ─────────────────────────────────┐
│ ResearchForm → 深度选择 + 问题输入                          │
│ SubQuestionConfirm → 可编辑的子问题列表（人机协作）         │
│ ProgressTree ← 阶段生命周期事件（可折叠）                  │
│ SourcesPanel ← 学术/网页来源分页展示                       │
│ ReportView ← 流式 Markdown 渲染（支持表格）               │
│ FollowUpChat → 讨论、建议修改、添加文献                    │
│ VersionSelector → 浏览版本、对比差异                       │
│ ProjectSelector → 固定侧边栏项目列表                       │
└────────────────────────────────────────────────────────────┘

┌─────────── 后端（云函数）──────────────────────────────────┐
│ /research  — 主研究流程（单 Agent + 工具调用）             │
│   阶段1: decomposeOnly → 返回子问题给用户确认              │
│   阶段2: confirmedSubQuestions → 搜索 + 综合报告           │
│   自动续写循环（最多 15 次重试）                           │
│   生成后结构检查 & 清理                                    │
│ /chat     — 继续研究对话（轻量 Agent，无工具）             │
│ /project  — 项目 CRUD + 版本管理 + 聊天持久化（Blob）      │
│ /scrape   — URL 内容提取（browser_fetch 工具）             │
│ /stop     — 取消正在进行的研究                             │
│ /health   — 健康检查                                       │
└────────────────────────────────────────────────────────────┘
```

## 研究流程

```
1. 用户输入研究问题 + 选择深度（快速/标准/深度）
2. POST /research (decomposeOnly=true) → 生成子问题
3. 前端展示 SubQuestionConfirm → 用户编辑/确认
4. POST /research (confirmedSubQuestions=[...]) → 正式研究
5. Agent 调用 search_literature（CrossRef + Semantic Scholar）
6. Agent 调用 search_web（web_search 工具 + 降级策略）
7. Agent 撰写报告（SSE 流式推送）
8. 如报告不完整，自动续写（检查是否有结论 + 参考文献）
9. 结构检查：移除重复章节，修复格式
10. 前端保存版本到 /project → 版本列表更新
11. 用户通过 FollowUpChat 继续研究（聊天记录持久化到 Blob）
```

## 使用的 EdgeOne Makers 平台能力

| 能力 | 用途 |
|------|------|
| `context.tools.get('web_search')` | 内置网页搜索工具（首选策略） |
| `context.tools.get('browser_fetch')` | 使用真实 Chromium 抓取 URL |
| `context.sandbox.commands.run()` | Shell 命令执行（curl 搜索降级） |
| `@edgeone/pages-blob` | 项目存储、版本管理、聊天记录持久化 |
| 云函数 (`agents/` 目录) | 每个 .ts 文件自动映射为 HTTP 端点 |
| AI Gateway | 通过 `@makers/deepseek-v4-flash` 访问大模型 |

## 快速开始

```bash
# 安装依赖
npm install

# 复制环境变量
cp .env.example .env
# 编辑 .env，填入 AI Gateway 凭证

# 启动开发
edgeone makes dev

# 修改 agent 文件后需要强制重建：
rm -rf .edgeone/agent-node && edgeone makes dev
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `AI_GATEWAY_API_KEY` | 是 | AI Gateway API 密钥 |
| `AI_GATEWAY_BASE_URL` | 是 | AI Gateway 基础 URL |

> 注意：`PROJECT_ID` 和 `EDGEONE_PAGES_API_TOKEN` 在部署时自动注入。本地开发如需 Blob 持久化，需手动在 `.env` 中配置。未配置时应用仍可正常使用，但项目和聊天记录不会持久保存（会显示警告提示）。

## 项目结构

```
deep-research-edgeone/
├── agents/
│   ├── _shared.ts        # 模型/Provider 初始化、SSE 工具、safeFetch、沙箱工具
│   ├── research.ts       # 主研究 Agent（分解 + 搜索 + 综合 + 续写 + 结构检查）
│   ├── chat.ts           # 继续研究对话 Agent（轻量，无工具）
│   ├── project.ts        # 项目 CRUD + 版本管理 + 聊天持久化（Blob）
│   ├── scrape.ts         # URL 抓取（browser_fetch + safeFetch 降级）
│   ├── stop.ts           # 取消研究
│   └── health.ts         # 健康检查
├── app/
│   ├── page.tsx          # 主页面（状态管理、SSE 消费、两阶段流程）
│   ├── layout.tsx
│   ├── globals.css       # Tailwind + prose-research 样式（表格、代码块）
│   └── components/
│       ├── research-form.tsx        # 问题输入 + 深度选择
│       ├── sub-question-confirm.tsx # 人机协作可编辑子问题列表
│       ├── progress-tree.tsx        # 阶段生命周期 + 可折叠子问题
│       ├── sources-panel.tsx        # 学术/网页来源分页
│       ├── source-card.tsx          # 单条来源展示
│       ├── report-view.tsx          # 流式 Markdown 渲染（remark-gfm）
│       ├── follow-up-chat.tsx       # 聊天 + 重新生成 + 添加文献 + Blob 持久化
│       ├── project-selector.tsx     # 固定侧边栏项目列表
│       ├── version-selector.tsx     # 版本历史 + 对比
│       └── diff-view.tsx            # 并排版本差异
├── components/ui/         # 共享 UI 组件（Card、Button、Tabs 等）
├── lib/
│   ├── i18n.tsx          # 中英文翻译
│   └── utils.ts
├── .env.example
└── package.json
```

## 开发注意事项

- **Agent 重建**：修改 `agents/` 文件后执行 `rm -rf .edgeone/agent-node && edgeone makes dev`
- **模型**：使用 `@makers/deepseek-v4-flash`（写死）。该模型可能每次只输出 ~300 token，自动续写循环会处理这个问题。
- **网页搜索**：首选内置 `web_search` 工具，降级到 curl Bing/DuckDuckGo，最终降级到 mock 数据。
- **Blob 不可用**：未配置 `PROJECT_ID`/`EDGEONE_PAGES_API_TOKEN` 时显示黄色警告条。应用仍可正常使用，但项目和聊天记录不持久化。
- **增量编辑**：继续研究时发送完整旧报告给模型，指示仅修改用户要求的部分。
- **结构检查**：报告生成后自动移除重复的结论/参考文献章节。

## 部署

```bash
edgeone makes deploy
```

部署后所有平台能力（Blob、Sandbox、Tools、AI Gateway）自动可用。

## 许可证

MIT
