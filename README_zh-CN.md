# Deep Research（深度研究助手）

**语言：** [English](./README.md) | 简体中文

基于 OpenAI Agents SDK 构建、部署在 EdgeOne Makers 上的多 Agent 深度研究助手，支持人机协同子问题确认、学术与网页搜索、迭代式报告生成及项目级版本管理。

**Framework:** None (raw Node.js) · **Category:** Orchestration · **Language:** TypeScript

[![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=deep-research-agent&from=within&fromAgent=1&agentLang=typescript)

<!-- TODO: confirm -->
![preview](./assets/preview.png)

## Overview

本模板自动化生成严谨、带引用的研究报告。它将研究问题分解为子问题供用户确认，检索学术数据库与实时网页，将发现综合为结构化 Markdown 报告，并支持带完整版本历史的跟进编辑。自动续写循环可在模型输出截断时确保报告完整。

- **人机协同规划** — AI 将问题分解为子问题，用户在研究执行前进行审阅、编辑与确认。
- **双源搜索** — 查询 CrossRef + Semantic Scholar 获取学术论文，同时通过实时网页搜索获取新闻与文章。
- **自动续写** — 检测报告是否缺失结论或参考文献，自动最多续写 15 次直至完整。
- **增量编辑** — 跟进研究加载已有报告，仅修改用户指定部分，保留原有结构。
- **项目与版本管理** — 研究项目、报告版本与跟进对话历史均持久化到 Blob 存储。

## Environment Variables

| 变量 | 必填 | 说明 |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | 是 | 模型网关 API Key。使用 Makers Models 的 API Key，或任何兼容 OpenAI 协议的提供商 Key。 |
| `AI_GATEWAY_BASE_URL` | 是 | 网关基础地址。使用 Makers Models 时填写 `https://ai-gateway.edgeone.link/v1`。 |

本模板遵循 OpenAI 兼容标准 —— 可指向 Makers Models 或任何兼容提供商。

### 如何获取 AI_GATEWAY_API_KEY

1. 打开 Makers 控制台（https://console.cloud.tencent.com/edgeone/makers）
2. 登录并启用 Makers
3. 进入 Makers → Models → API Key，创建 Key
4. 将其填入 `AI_GATEWAY_API_KEY`

> 内置模型在额度内免费，适合验证；生产环境请绑定自费厂商 Key（BYOK）。

## 本地开发

**前置依赖**
- Node.js 18+
- EdgeOne CLI（`npm i -g @edgeone/cli`）

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 AI_GATEWAY_API_KEY 与 AI_GATEWAY_BASE_URL
edgeone makers dev
```

本地可观测面板地址：http://localhost:8080/agent-metrics。

## 项目结构

```
deep-research-agent/
├── agents/
│   ├── _shared.ts          # 模型 / Provider 初始化、SSE 辅助函数、safeFetch、沙箱工具
│   ├── _tools.ts           # 工具工厂（分解、学术、网页、抓取）
│   ├── _prompts.ts         # 系统提示构建器 + ResearchOptions
│   ├── _sources.ts         # 论文 / 文章类型与学术 API 解析器
│   ├── _web-search.ts      # 多引擎降级搜索
│   ├── _project-store.ts   # 版本持久化辅助函数
│   ├── _follow-up.ts       # 跟进编辑流（无搜索路径）
│   ├── _report-cleanup.ts  # 生成后结构清理
│   ├── research.ts         # POST /research —— 主研究流水线
│   ├── chat.ts             # POST /chat —— 跟进对话
│   ├── scrape.ts           # POST /scrape —— URL 内容提取
│   └── stop.ts             # POST /stop —— 取消活跃研究
├── cloud-functions/
│   ├── project/            # POST /project —— 项目增删改查 + 版本
│   ├── enrich-doi/         # POST /enrich-doi —— DOI 元数据丰富
│   └── health/             # GET /health
├── app/                    # Next.js App Router 前端
├── components/             # UI 组件（报告视图、对话、版本对比等）
├── lib/
│   ├── i18n.tsx            # 中 / 英翻译
│   └── utils.ts
└── edgeone.json            # EdgeOne 部署配置
```

以 `_` 为前缀的文件是私有模块，不会作为公共路由暴露。

## 工作原理

### 运行模式
`agents/` 下的文件以**会话模式**运行：相同 `conversation_id` 的请求会被粘性路由到同一 Agent 实例。`/research` Agent 通过 `context.store.openaiSession(conversationId)` 跨轮次持久化对话历史。

### 端到端流程

1. **输入问题** —— 用户输入研究问题并选择深度（`quick` / `standard` / `deep`）。
2. **子问题分解** —— 前端调用 `/research` 并传入 `decomposeOnly=true`。专用子 Agent 生成聚焦子问题。
3. **人工确认** —— 前端展示可编辑的子问题列表；用户确认或修改。
4. **完整研究** —— 前端再次调用 `/research` 并传入 `confirmedSubQuestions`。主 Agent 依次执行：
   - `decompose_question` —— 将子问题列表形式化。
   - `search_literature` —— 查询 CrossRef 与 Semantic Scholar 获取学术论文。
   - `search_web` —— 使用内置 `web_search` 工具（带沙箱 curl 降级）。
   - `scrape_urls` —— 当提供用户指定 URL 时提取其内容。
5. **综合撰写** —— 所有工具输出收集完毕后，综合 Agent 通过 SSE 流式输出 Markdown 报告。
6. **自动续写** —— 若报告缺少结论或参考文献章节，续写 Agent 从断点处继续（最多 15 次）。
7. **结构清理** —— 自动移除重复章节、泄漏的思维标签与格式问题。
8. **持久化** —— 最终报告、来源与元数据通过 `context.store` 保存到 Blob（或降级到 `/project` 云函数）。
9. **跟进对话** —— 用户通过 `/chat` 讨论报告；当达成修改共识后，前端触发跟进研究运行，在原位编辑已有报告。

### 关键路由与参数
- `/research` —— 请求体：`{ message/question, depth, projectId, urls, confirmedSubQuestions, decomposeOnly, locale, citationStyle }`。
- `/chat` —— 请求体：`{ message, chatHistory, report }`。轻量级对话端点，无搜索工具。
- `/scrape` —— 请求体：`{ urls }`。使用 `browser_fetch` 或沙箱 curl 提取 URL 内容。
- `/project` —— 请求体因动作而异。处理项目增删改查、版本列表与对话历史持久化。
- `/stop` —— 请求体：`{ conversationId }`。取消活跃研究运行。

### 运行参数
- `agents.timeout`：300 秒

## 相关资源

- [Makers Agents 文档](https://edgeone.ai/makers)
- [Makers 快速开始](https://edgeone.ai/makers/docs/quickstart)
- [Makers Models](https://console.cloud.tencent.com/edgeone/makers/models)

## 许可证

MIT
