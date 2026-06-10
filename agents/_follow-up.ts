/**
 * Follow-up editing flow.
 *
 * Lightweight path used when isFollowUp=true: skips decompose/search,
 * edits the previous report directly with a no-tool agent. Replays the
 * 4-stage lifecycle so the frontend's left panel still shows sub-questions
 * and citations during the edit (which doesn't actually re-search) — see
 * the "Plan B" notes in the project history.
 */
import {
  Agent,
  run,
  getModel,
  createLogger,
  sseEvent,
} from './_shared';
import type { ResearchOptions } from './_prompts';
import { buildEditorSystemPrompt } from './_prompts';
import { validateCitations } from './_report-cleanup';
import { saveVersionToStore } from './_project-store';

const logger = createLogger('follow-up');

export async function* streamFollowUpEdit(
  modificationRequest: string,
  previousReport: string,
  opts: ResearchOptions,
  context: any,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const { depth, projectId, locale, previousPapers = [], previousArticles = [], previousScrapedUrls = [], previousSubQuestions = [] } = opts;
  const isEnglish = locale === 'en';
  // Runtime auto-injects `context.conversation_id` from the HTTP header.
  const conversationId = context.conversation_id || '';
  const session = context.store?.openaiSession?.(conversationId);

  // Replay the standard 4-stage lifecycle so the left panel still shows
  // sub-questions / papers / articles during follow-up edit (which doesn't
  // actually re-search). The frontend parses `content` (JSON array) on each
  // `complete` event and rebuilds the sources panel from it.
  if (previousSubQuestions.length > 0) {
    yield sseEvent({
      type: 'subagent_lifecycle',
      status: 'complete',
      agent: 'question-decomposer',
      id: 'stage-1',
      content: JSON.stringify(previousSubQuestions),
    });
  } else {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1' });
  }

  if (previousPapers.length > 0) {
    yield sseEvent({
      type: 'subagent_lifecycle',
      status: 'complete',
      agent: 'literature-searcher',
      id: 'stage-2',
      content: JSON.stringify(previousPapers),
    });
  } else {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'literature-searcher', id: 'stage-2' });
  }

  if (previousArticles.length > 0) {
    yield sseEvent({
      type: 'subagent_lifecycle',
      status: 'complete',
      agent: 'web-researcher',
      id: 'stage-3',
      content: JSON.stringify(previousArticles),
    });
  } else {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'web-researcher', id: 'stage-3' });
  }

  // Show the synthesizer stage (editing = synthesis without search)
  yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
  yield sseEvent({ type: 'progress', step: 1, total: 1, label: 'Editing report...' });

  const editorAgent = new Agent({
    name: 'report-editor',
    instructions: buildEditorSystemPrompt(isEnglish),
    model: getModel(context.env),
    tools: [],
    modelSettings: { maxTokens: 65536 },
  });

  const input = [{
    role: 'user' as const,
    content: `## Modification Request:\n${modificationRequest}\n\n## Report to Edit:\n${previousReport}`,
  }];

  let report = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    const result = await run(editorAgent, input as any, {
      stream: true,
      signal,
      maxTurns: 3,
      modelSettings: { maxTokens: 65536 },
      ...(session ? { session } : {}),
    } as any) as any;

    for await (const event of result) {
      if (signal?.aborted) break;

      if (event.type === 'raw_model_stream_event') {
        const data = (event as any).data;
        if (data?.type === 'output_text_delta' && data.delta) {
          const text = data.delta;
          if (!text.includes('<think>') && !text.includes('</think>')) {
            report += text;
            yield sseEvent({ type: 'ai_response', content: text, agent: 'synthesizer' });
          }
        }
      } else if (event.type === 'run_item_stream_event') {
        const item = event.item as any;
        if (item.rawItem?.usage) {
          totalInputTokens += item.rawItem.usage.input_tokens || 0;
          totalOutputTokens += item.rawItem.usage.output_tokens || 0;
        }
      }
    }
    await result.completed;

    // Fallback: non-streaming output
    if (!report) {
      const output = result.finalOutput;
      if (typeof output === 'string' && output) {
        report = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        yield sseEvent({ type: 'ai_response', content: report, agent: 'synthesizer' });
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError' && !signal?.aborted) {
      logger.error('Follow-up edit error:', e.message);
      yield sseEvent({ type: 'error_message', content: e.message });
    }
  }

  if (report) {
    // Drop any references section the editor wrote and strip ghost [n] beyond
    // the reused source set. The app renders the canonical reference list.
    const maxNumber = previousPapers.length + previousArticles.length;
    const cleaned = validateCitations(report, maxNumber);
    if (cleaned !== report) {
      report = cleaned;
      yield sseEvent({ type: 'report_replace', content: report });
    }

    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'synthesizer', id: 'stage-4' });
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      yield sseEvent({ type: 'token_usage', input: totalInputTokens, output: totalOutputTokens });
    }

    // Save the edited version to project store (backend primary save).
    // Reuse the previous version's papers/articles/scrapedUrls so the version
    // history remains source-complete (follow-up edits don't change citations).
    if (projectId && context.store) {
      const newVersion = await saveVersionToStore(context.store, projectId, {
        question: modificationRequest,
        depth,
        subQuestions: previousSubQuestions,
        papers: previousPapers,
        articles: previousArticles,
        scrapedUrls: previousScrapedUrls,
        report,
        trigger: 'follow-up',
      });
      if (newVersion) {
        logger.log(`Follow-up version saved for project ${projectId} as v${newVersion} (reused ${previousPapers.length} papers, ${previousArticles.length} articles)`);
      }
    }
  }

  yield sseEvent({ type: 'research_complete', sources: [] });
  yield 'data: [DONE]\n\n';
}
