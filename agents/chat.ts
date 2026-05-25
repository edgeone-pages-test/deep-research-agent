/**
 * Chat Agent — Lightweight conversational endpoint for follow-up discussions.
 *
 * POST /chat
 * Body: { message, projectId, chatHistory, report }
 *
 * This does NOT perform searches. It uses the existing report as context
 * and answers user questions in a conversational manner.
 *
 * When the AI detects the user wants to update/regenerate the report,
 * it includes [SUGGEST_REGENERATE] in its response, which the frontend
 * converts into a "Regenerate Report" button.
 */
import {
  Agent,
  run,
  ensureProvider,
  getModel,
  createLogger,
  createSSEResponse,
  sseEvent,
} from './_shared';

const logger = createLogger('chat');

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function buildChatSystemPrompt(report: string): string {
  const reportContext = report.length > 4000 ? report.slice(0, 4000) + '\n...(报告已截断)' : report;

  return `你是一个研究助手，用户正在围绕一份已完成的研究报告与你对话。

## 当前研究报告：
${reportContext}

## 你的角色：
1. 回答用户对报告内容的追问和疑问
2. 解释报告中的观点、数据或引用
3. 根据用户提供的新链接或新信息进行补充分析
4. 对报告的某些段落提出改进建议
5. 帮助用户理解研究的背景和意义

## 关于报告修改：
- 如果用户明确要求修改报告（如"更新报告"、"重新生成"、"把这个加进去"、"修改报告"等），在你的回复末尾另起一行加上：[SUGGEST_REGENERATE]
- 如果对话中积累了足够多的新信息和方向，用户可能需要更新报告时，也在末尾加上：[SUGGEST_REGENERATE]
- 不要在每次回复都加，只在真正有实质性修改需求时才加
- 在 [SUGGEST_REGENERATE] 之前，先用一句话总结你建议修改的要点

## 注意：
- 用与报告相同的语言回复
- 保持简洁的对话风格，不需要写成报告格式
- 回复控制在 300-500 字以内，除非用户要求详细解释
- 不要重复报告内容，而是提供新的见解或解答`;
}

async function* streamChat(
  message: string,
  chatHistory: ChatMessage[],
  report: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  ensureProvider();

  const agent = new Agent({
    name: "research-chat",
    instructions: buildChatSystemPrompt(report),
    model: getModel(),
    tools: [],
    modelSettings: {
      maxTokens: 4096,
    },
  });

  // Build conversation input from history + new message
  const input = [
    ...chatHistory.slice(-10).map(m => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: message },
  ];

  let response = '';
  let suggestRegenerate = false;

  try {
    const result = await run(agent, input as any, {
      stream: true,
      signal,
      maxTurns: 1,
      modelSettings: { maxTokens: 4096 },
    });

    for await (const event of result) {
      if (signal?.aborted) break;

      if (event.type === "raw_model_stream_event") {
        const data = (event as any).data;
        if (data?.type === 'output_text_delta' && data.delta) {
          const text = data.delta;
          // Skip <think> blocks
          if (!text.includes('<think>') && !text.includes('</think>')) {
            response += text;
            // Don't stream the [SUGGEST_REGENERATE] marker to the user
            if (!text.includes('[SUGGEST_REGENERATE]')) {
              yield sseEvent({ type: 'chat_response', content: text });
            }
          }
        }
      }
    }

    await result.completed;

    // If no streaming output, get from finalOutput
    if (!response) {
      const output = result.finalOutput;
      if (typeof output === 'string' && output) {
        response = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const cleanResponse = response.replace('[SUGGEST_REGENERATE]', '').trim();
        if (cleanResponse) {
          yield sseEvent({ type: 'chat_response', content: cleanResponse });
        }
      }
    }

    // Check if AI suggested regeneration
    if (response.includes('[SUGGEST_REGENERATE]')) {
      suggestRegenerate = true;
      // Extract the suggestion context (text before the marker)
      const parts = response.split('[SUGGEST_REGENERATE]');
      const suggestion = parts[0].trim().split('\n').pop()?.trim() || '';
      yield sseEvent({ type: 'suggest_regenerate', suggestion });
    }

    logger.log(`Chat complete, length=${response.length}, suggestRegenerate=${suggestRegenerate}`);
  } catch (e: any) {
    if (e.name !== 'AbortError' && !signal?.aborted) {
      logger.error('Chat error:', e.message);
      yield sseEvent({ type: 'error_message', content: e.message });
    }
  }

  yield sseEvent({ type: 'chat_done' });
  yield "data: [DONE]\n\n";
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { message, chatHistory = [], report = '' } = body;

  if (!message) {
    return new Response(JSON.stringify({ error: 'Missing message' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!report) {
    return new Response(JSON.stringify({ error: 'Missing report context' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const signal = request?.signal as AbortSignal | undefined;
  const generator = streamChat(message, chatHistory, report, signal);
  return createSSEResponse(generator, signal);
}
