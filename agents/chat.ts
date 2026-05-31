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
  const reportContext = report.length > 4000 ? report.slice(0, 4000) + '\n...(report truncated)' : report;

  return `You are a research assistant helping a user discuss and refine a completed research report.

## Current Research Report:
${reportContext}

## Your Role:
1. Answer follow-up questions about the report's content
2. Explain key findings, data points, or citations in the report
3. Analyze supplementary information or URLs provided by the user
4. Suggest improvements to specific sections
5. Help the user understand the research context and significance

## Report Modification:
- Append [SUGGEST_REGENERATE] on a new line at the end of your response when:
  1. The user explicitly asks to modify the report (e.g., "update the report", "regenerate", "add this to the report", "revise section X")
  2. The user confirms a suggested change (e.g., "yes", "ok", "go ahead", "sounds good")
  3. A concrete modification plan has been agreed upon in the conversation (new chapter, revised paragraph, added content, etc.)
  4. The user wants to incorporate new information or analysis into the report
- When the user says things like "put this in the report" or "add this", the intent is clear — don't ask again. Provide the modification plan and append [SUGGEST_REGENERATE].
- Do NOT add this marker for pure Q&A where no modification is intended.
- Before [SUGGEST_REGENERATE], include a one-sentence summary of what will be changed.

## Source / Literature Updates:
- If the user mentions papers are outdated, citations need updating, or provides new paper links/DOIs/references:
  - Append [SUGGEST_ADD_SOURCE]{"title":"paper title","url":"link (if any)","year":year (if any),"authors":"authors (if any)"} on a new line
  - Multiple sources can be added, one per line
  - Fill in the fields from user-provided information; partial data is fine
  - Before the marker, confirm in one sentence what the user wants to add
- Do NOT add this marker without a clear intent to add/update sources.

## HARD RULE — NEVER OUTPUT A FULL REPORT IN CHAT:
- You are a CHAT assistant. You NEVER write out a full or modified report here.
- NEVER output full sections, full chapters, or any substantial block of the modified report text.
- When a modification is agreed upon: write ONE brief sentence summarising the change, then append [SUGGEST_REGENERATE] on a new line. That's it.
- If you feel the urge to write "以下是更新后的报告" or "Here is the updated report" — STOP immediately and output [SUGGEST_REGENERATE] instead.
- The actual report editing is done by a separate pipeline after the user clicks "Regenerate Report". Your job is only to agree on WHAT to change, not to do the editing.

## Guidelines:
- Reply in the same language as the report
- Keep responses conversational and concise — this is a chat, not a report
- Aim for 150–300 words unless the user requests a detailed explanation
- Do not simply restate the report; offer new insights or direct answers`;
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
      maxTurns: 3,
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
            // Don't stream the [SUGGEST_REGENERATE] or [SUGGEST_ADD_SOURCE] markers to the user
            if (!text.includes('[SUGGEST_REGENERATE]') && !text.includes('[SUGGEST_ADD_SOURCE]')) {
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

    // Check if AI suggested adding sources
    const sourceMatches = [...response.matchAll(/\[SUGGEST_ADD_SOURCE\](\{[^\n]+\})/g)];
    for (const match of sourceMatches) {
      try {
        const sourceData = JSON.parse(match[1]);
        yield sseEvent({ type: 'suggest_add_source', source: sourceData });
      } catch {}
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
