/**
 * Deep Research Agent — OpenAI Agents SDK
 *
 * Single agent with function tools that orchestrates the full research pipeline:
 *   1. decompose_question — breaks research question into sub-questions
 *   2. search_literature — queries CrossRef + Semantic Scholar
 *   3. search_web — uses platform's web_search tool with sandbox curl fallback
 *   4. (Final output) — agent synthesizes a report with citations
 *
 * Runs as a one-shot flow: question → tools → report.
 * Streaming via SSE: tool_call events map to progress stages on the frontend.
 *
 * Code organisation:
 *   - _shared.ts          → SDK re-exports, logger, sseEvent, safeFetch
 *   - _project-store.ts   → version persistence (mirrors cloud-functions/project)
 *   - _sources.ts         → Paper / Article types + academic API parsers
 *   - _web-search.ts      → multi-engine fallback (sandbox curl → safeFetch)
 *   - _tools.ts           → 4 tool factories (per-request context closures)
 *   - _prompts.ts         → buildSystemPrompt + ResearchOptions
 *   - _follow-up.ts       → streamFollowUpEdit (no-search edit path)
 *   - _report-cleanup.ts  → post-processing for synthesizer output
 *   - research.ts (this)  → streamResearch + onRequest HTTP handler
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
import {
  saveVersionToStore,
  getLastVersionFromStore,
  archiveStandaloneReport,
} from './_project-store';
import { buildResearchTools } from './_tools';
import { buildSystemPrompt, type ResearchOptions } from './_prompts';
import { streamFollowUpEdit } from './_follow-up';
import { cleanReportStructure, stripStreamPreamble, validateCitations } from './_report-cleanup';

const logger = createLogger('research');

// ─── Stream ──────────────────────────────────────────────────────────────────

async function* streamResearch(
  question: string,
  opts: ResearchOptions,
  context: any,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  ensureProvider(context.env);

  // Build per-request tool instances with this request's context closed over.
  const { decomposeQuestion, searchLiterature, searchWeb, scrapeUrls } = buildResearchTools(context);

  const { depth, projectId, urls, previousReport, isFollowUp, confirmedSubQuestions, decomposeOnly } = opts;
  // Runtime auto-injects `context.conversation_id` from the
  // `makers-conversation-id` HTTP header — single channel is enough
  // (SOP platform-conventions §"Headers").
  const conversationId = context.conversation_id || '';

  // OpenAI Agents SDK session for conversation history persistence
  const session = context.store?.openaiSession?.(conversationId);

  // ─── Follow-up editing mode: skip search, edit existing report directly ───
  if (isFollowUp && previousReport) {
    yield* streamFollowUpEdit(question, previousReport, opts, context, signal);
    return;
  }

  // ─── DecomposeOnly mode: just generate sub-questions and return ───
  if (decomposeOnly) {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'question-decomposer', id: 'stage-1' });
    yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'question-decomposer', id: 'stage-1' });

    const decomposeAgent = new Agent({
      name: 'question-decomposer',
      instructions: `You are a research question decomposer. Break the given research question into focused sub-questions.
Generate ${depth === 'quick' ? '2-3' : depth === 'deep' ? '5-7' : '3-5'} sub-questions that cover:
- Background and definitions
- Current state of research
- Key challenges and debates
- Future directions and applications
Write sub-questions in the same language as the input question.
Call the decompose_question tool with your generated sub-questions.`,
      model: getModel(context.env),
      tools: [decomposeQuestion],
      modelSettings: { maxTokens: 2048 },
    });

    try {
      const result = await run(decomposeAgent, [{ role: 'user', content: question }] as any, {
        stream: true, signal, maxTurns: 10, modelSettings: { maxTokens: 4096 },
        ...(session ? { session } : {}),
      } as any) as any;

      let subQs: string[] = [];
      for await (const event of result) {
        if (signal?.aborted) break;
        if (event.type === 'run_item_stream_event') {
          const item = event.item as any;
          if (item.type === 'tool_call_output_item') {
            try {
              const parsed = JSON.parse(item.output || '');
              if (parsed.subQuestions) subQs = parsed.subQuestions;
            } catch {}
          }
        }
      }
      await result.completed;

      if (subQs.length === 0) {
        // Fallback
        subQs = [
          `What is the current state of "${question}"?`,
          `What are the main challenges in "${question}"?`,
          `What are the future directions for "${question}"?`,
        ];
      }

      yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1', content: JSON.stringify(subQs) });
      yield sseEvent({ type: 'decompose_complete', subQuestions: subQs });
    } catch (e: any) {
      if (e.name !== 'AbortError' && !signal?.aborted) {
        yield sseEvent({ type: 'error_message', content: e.message });
      }
    }

    yield 'data: [DONE]\n\n';
    return;
  }

  // ─── Full research mode ───
  // Initialize progress stages
  if (confirmedSubQuestions && confirmedSubQuestions.length > 0) {
    // Skip decompose stage — already confirmed
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1', content: JSON.stringify(confirmedSubQuestions) });
  } else {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'question-decomposer', id: 'stage-1' });
  }
  yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'literature-searcher', id: 'stage-2' });
  yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'web-researcher', id: 'stage-3' });
  yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'synthesizer', id: 'stage-4' });

  const tools = confirmedSubQuestions ? [searchLiterature, searchWeb] : [decomposeQuestion, searchLiterature, searchWeb];
  if (urls && urls.length > 0) {
    tools.push(scrapeUrls as any);
  }

  const agent = new Agent({
    name: 'deep-research',
    instructions: buildSystemPrompt(opts),
    model: getModel(context.env),
    tools,
    modelSettings: { maxTokens: 65536 },
  });

  const input = confirmedSubQuestions
    ? [{ role: 'user', content: `${question}\n\nPre-confirmed sub-questions:\n${confirmedSubQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` }]
    : [{ role: 'user', content: question }];

  let report = '';
  let papers: any[] = [];
  let articles: any[] = [];
  let subQuestions: string[] = confirmedSubQuestions || [];
  let scrapedUrls: any[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    // maxTurns: 15 allows tool calls + long report generation
    const result = await run(agent, input as any, {
      stream: true, signal, maxTurns: 15, modelSettings: { maxTokens: 65536 },
      ...(session ? { session } : {}),
    } as any) as any;

    let synthesizing = false;
    let allToolsDone = false;   // Track if all tool outputs received
    // Preamble buffer: hold initial synthesizer chunks until the first markdown
    // heading appears, then strip known AI preamble phrases before emitting.
    let streamBuffer = '';
    let streamBufferFlushed = false;

    for await (const event of result) {
      if (signal?.aborted) break;

      if (event.type === 'run_item_stream_event') {
        const item = event.item as any;

        if (item.type === 'tool_call_item') {
          const raw = item.rawItem;
          const toolName = raw?.name || 'tool';
          allToolsDone = false;  // New tool call starting, not done yet
          // If we were accumulating pre-tool-call text, discard it
          if (synthesizing) {
            synthesizing = false;
            report = '';
          }

          // Map tool calls to progress stages
          if (toolName === 'decompose_question') {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'question-decomposer', id: 'stage-1' });
            yield sseEvent({ type: 'progress', step: 1, total: 4, label: 'Decomposing research question...' });
          } else if (toolName === 'search_literature') {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'literature-searcher', id: 'stage-2' });
            yield sseEvent({ type: 'progress', step: 2, total: 4, label: 'Searching academic papers...' });
          } else if (toolName === 'search_web') {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'web-researcher', id: 'stage-3' });
            yield sseEvent({ type: 'progress', step: 3, total: 4, label: 'Searching web articles...' });
          } else if (toolName === 'scrape_urls') {
            yield sseEvent({ type: 'progress', step: 3, total: 4, label: 'Scraping user-provided URLs...' });
          }
        } else if (item.type === 'tool_call_output_item') {
          const output = item.output || '';
          const toolName = item.rawItem?.name || '';
          allToolsDone = true;  // Tool completed — next text delta is likely the report

          // Parse tool results for frontend sources display
          try {
            const parsed = JSON.parse(output);
            if (toolName === 'decompose_question' && parsed.subQuestions) {
              subQuestions = parsed.subQuestions;
              yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1', content: JSON.stringify(subQuestions) });
              yield sseEvent({ type: 'ai_response', content: subQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n'), agent: 'question-decomposer' });
            } else if (toolName === 'search_literature' && parsed.papers) {
              papers = parsed.papers;
              yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'literature-searcher', id: 'stage-2', content: JSON.stringify(papers) });
            } else if (toolName === 'search_web' && parsed.articles) {
              articles = parsed.articles;
              yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'web-researcher', id: 'stage-3', content: JSON.stringify(articles) });
            } else if (toolName === 'scrape_urls' && parsed.scrapedUrls) {
              scrapedUrls = parsed.scrapedUrls;
              logger.log(`Scraped ${scrapedUrls.length} URLs`);
            }
          } catch {}
        } else if (item.type === 'message_output_item') {
          // This is the final text output after all tool calls
          allToolsDone = true;
          if (!synthesizing) {
            synthesizing = true;
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
            yield sseEvent({ type: 'source_switch', agent: 'synthesizer' });
            yield sseEvent({ type: 'progress', step: 4, total: 4, label: 'Writing research report...' });
          }
        }
      } else if (event.type === 'raw_model_stream_event') {
        // Stream text deltas for the report
        const data = (event as any).data;
        if (data?.type === 'output_text_delta' && data.delta) {
          const text = data.delta;
          // Skip <think> blocks
          if (!text.includes('<think>') && !text.includes('</think>')) {
            // Only emit as report if all tools have completed
            if (allToolsDone) {
              if (!synthesizing) {
                synthesizing = true;
                yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
                yield sseEvent({ type: 'source_switch', agent: 'synthesizer' });
                yield sseEvent({ type: 'progress', step: 4, total: 4, label: 'Writing research report...' });
              }
              report += text;
              // Preamble buffering: hold chunks until the first markdown heading,
              // then strip known AI intro phrases before sending to the frontend.
              if (!streamBufferFlushed) {
                streamBuffer += text;
                const hasHeading = /(?:^|\n)#/.test(streamBuffer);
                if (hasHeading || streamBuffer.length >= 600) {
                  streamBufferFlushed = true;
                  const cleaned = stripStreamPreamble(streamBuffer);
                  if (cleaned) {
                    yield sseEvent({ type: 'ai_response', content: cleaned, agent: 'synthesizer' });
                  }
                }
                // else: still buffering — don't emit yet
              } else {
                yield sseEvent({ type: 'ai_response', content: text, agent: 'synthesizer' });
              }
            }
            // else: still in tool-calling phase or pre-tool text — don't emit as report
          }
        }
        // Capture token usage from response.completed or response.done events
        if (data?.type === 'response.completed' || data?.type === 'response.done') {
          const usage = data?.response?.usage || data?.usage;
          if (usage) {
            totalInputTokens += usage.input_tokens || usage.prompt_tokens || 0;
            totalOutputTokens += usage.output_tokens || usage.completion_tokens || 0;
          }
        }
        // Also capture from chat.completion.chunk usage (OpenAI format)
        if (data?.usage) {
          const u = data.usage;
          if (u.prompt_tokens && u.completion_tokens) {
            totalInputTokens += u.prompt_tokens;
            totalOutputTokens += u.completion_tokens;
          }
        }
      }
    }

    // Finalize
    await result.completed;

    // If report wasn't captured via streaming, get from finalOutput
    if (!report) {
      const output = result.finalOutput;
      if (typeof output === 'string' && output) {
        report = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (report) {
          if (!synthesizing) {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
            yield sseEvent({ type: 'source_switch', agent: 'synthesizer' });
            yield sseEvent({ type: 'progress', step: 4, total: 4, label: 'Writing research report...' });
          }
          yield sseEvent({ type: 'ai_response', content: report, agent: 'synthesizer' });
        }
      }
    }

    logger.log('Research complete');
  } catch (e: any) {
    if (e.name === 'AbortError' || signal?.aborted) {
      // Normal cancellation
    } else if (e.message?.includes('Max turns')) {
      logger.log('Max turns reached');
      yield sseEvent({ type: 'error_message', content: 'Research tools completed but report generation was interrupted. Please try again.' });
    } else if (e.message?.includes('terminated')) {
      logger.log('Stream terminated by runtime (likely timeout)');
      if (report) {
        report += '\n\n---\n*[Note: Report generation was interrupted due to connection timeout. The above content is partial.]*';
      }
    } else {
      logger.error('Agent error:', e.message);
      // Don't emit error to user if we already have a partial report — we'll try to continue
      if (!report) {
        yield sseEvent({ type: 'error_message', content: e.message });
      } else {
        logger.log(`Agent ended with error but report exists (len=${report.length}), attempting continuation...`);
      }
    }
  }

  // ─── Continuation: detect if report was cut short and continue (with retry loop) ───
  const MAX_CONTINUATIONS = 15;
  for (let attempt = 0; attempt < MAX_CONTINUATIONS && !signal?.aborted; attempt++) {
    // No report at all — nothing to continue
    if (!report || report.length === 0) break;

    const reportLower = report.toLowerCase();
    const hasConclusion = reportLower.includes('## 结论') || reportLower.includes('## conclusion') ||
      reportLower.includes('## 总结');

    // Report is complete if it has a conclusion AND is reasonably long. The
    // model no longer writes a references section (the app generates it), so
    // we no longer gate completion on one.
    if (hasConclusion && report.length > 2000) {
      logger.log(`Report appears complete (len=${report.length}). No continuation needed.`);
      break;
    }

    // If report is already very long (>8000 chars), stop regardless to prevent infinite loops
    if (report.length > 8000) {
      logger.log(`Report is already ${report.length} chars, stopping continuation to prevent infinite loop.`);
      break;
    }

    logger.log(`Report incomplete (attempt ${attempt + 1}/${MAX_CONTINUATIONS}, len=${report.length}, hasConclusion=${hasConclusion}). Continuing...`);

    try {
      const continueAgent = new Agent({
        name: 'report-continuator',
        instructions: `You are continuing an incomplete research report. The previous output was cut short. Continue writing from EXACTLY where it left off — do NOT add any prefix, greeting, or "continued from" note. Do NOT repeat any content that already exists. Complete ALL remaining sections following this exact structure: main body chapters → ## 结论 (or ## Conclusion). Do NOT write a references / 参考文献 section — the application generates it automatically. Keep all inline [n] citation numbers as-is; do NOT invent new numbers. Write in the same language as the existing content. Output ONLY the continuation text. Write as MUCH content as possible — aim for at least 2000 characters.`,
        model: getModel(context.env),
        tools: [],
        modelSettings: { maxTokens: 65536 },
      });

      const continueInput = [
        { role: 'user' as const, content: `The following research report was cut short at ${report.length} characters. Continue writing from where it stopped. You MUST output substantial content (at least 2000 characters). Complete the report with all remaining sections and the conclusion. Do NOT write a references section:\n\n---\n${report.slice(-3000)}` },
      ];

      const continueResult = await run(continueAgent, continueInput as any, {
        stream: true, signal, maxTurns: 3, modelSettings: { maxTokens: 65536 },
      } as any) as any;

      let continuation = '';
      for await (const event of continueResult) {
        if (signal?.aborted) break;
        if (event.type === 'raw_model_stream_event') {
          const data = (event as any).data;
          if (data?.type === 'output_text_delta' && data.delta) {
            const text = data.delta;
            if (!text.includes('<think>') && !text.includes('</think>')) {
              continuation += text;
              report += text;
              yield sseEvent({ type: 'ai_response', content: text, agent: 'synthesizer' });
            }
          }
          if (data?.type === 'response.completed' || data?.type === 'response.done') {
            const usage = data?.response?.usage || data?.usage;
            if (usage) {
              totalOutputTokens += usage.output_tokens || usage.completion_tokens || 0;
            }
          }
        }
      }
      await continueResult.completed;
      logger.log(`Continuation ${attempt + 1} added ${continuation.length} chars (total report: ${report.length} chars)`);

      // If continuation added nothing, stop retrying
      if (continuation.length < 10) {
        logger.log('Continuation produced no meaningful output, stopping');
        break;
      }
    } catch (e: any) {
      logger.log(`Continuation ${attempt + 1} failed: ${e.message}`);
      // Don't break — try again
    }
  }

  // ─── Structure check: clean up duplicate sections, leaked reasoning, etc. ───
  if (report) {
    const beforeLen = report.length;
    report = cleanReportStructure(report);
    // Validate citations: drop the model's own references section (the app
    // generates the canonical list) and strip any out-of-range ghost [n].
    report = validateCitations(report, papers.length + articles.length);
    if (report.length !== beforeLen) {
      // Send the full cleaned report to replace what's on screen
      yield sseEvent({ type: 'report_replace', content: report });
    }
  }

  // Mark synthesizer as complete (only once, after any continuation)
  if (report) {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'synthesizer', id: 'stage-4' });
  }

  // ─── Persist ─────────────────────────────────────────────────────────────
  if (projectId && report) {
    // Primary save: write directly via context.store (the same store the
    // /project cloud-function reads). No HTTP/RPC call required.
    if (context.store) {
      const newVersion = await saveVersionToStore(context.store, projectId, {
        question, depth, subQuestions, papers, articles, scrapedUrls, report, trigger: 'initial',
      });
      if (newVersion) {
        logger.log(`Version saved for project ${projectId} as v${newVersion}`);
      }
    }
    // else: frontend (page.tsx finally block) will save as fallback when context.store is unavailable
  } else if (context?.store && report) {
    // Standalone (non-project) report — archive under conversationId
    await archiveStandaloneReport(context.store, conversationId, {
      question, depth, subQuestions, papers, articles, scrapedUrls, report,
    });
  }

  // Estimate tokens if SDK didn't provide them (common with deepseek models)
  if (totalInputTokens === 0 && totalOutputTokens === 0 && report) {
    // Rough estimation: ~1.5 chars per token for mixed CJK/English
    const systemPromptLen = buildSystemPrompt(opts).length;
    totalInputTokens = Math.ceil((question.length + systemPromptLen) / 1.5);
    totalOutputTokens = Math.ceil(report.length / 1.5);
  }

  yield sseEvent({ type: 'usage', input_tokens: totalInputTokens, output_tokens: totalOutputTokens, total_tokens: totalInputTokens + totalOutputTokens });
  yield 'data: [DONE]\n\n';
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { message, question: questionField, depth = 'standard', projectId, urls, confirmedSubQuestions, decomposeOnly, locale, citationStyle } = body;
  const question = message || questionField || '';

  if (!question) {
    return new Response(JSON.stringify({ error: 'Missing research question' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Load previous report context if this is a follow-up in a project
  let previousReport: string | undefined;
  let previousPapers: any[] = [];
  let previousArticles: any[] = [];
  let previousScrapedUrls: any[] = [];
  let previousSubQuestions: string[] = [];
  let isFollowUp = false;

  if (projectId && context.store) {
    const last = await getLastVersionFromStore(context.store, projectId);
    if (last && last.version?.report) {
      isFollowUp = true;
      previousReport = last.version.report;
      previousPapers = Array.isArray(last.version.papers) ? last.version.papers : [];
      previousArticles = Array.isArray(last.version.articles) ? last.version.articles : [];
      previousScrapedUrls = Array.isArray(last.version.scrapedUrls) ? last.version.scrapedUrls : [];
      previousSubQuestions = Array.isArray(last.version.subQuestions) ? last.version.subQuestions : [];
      logger.log(`Loaded follow-up context: report=${previousReport!.length}chars papers=${previousPapers.length} articles=${previousArticles.length} scraped=${previousScrapedUrls.length} subQs=${previousSubQuestions.length}`);
    }
  }

  const signal = request?.signal as AbortSignal | undefined;
  const opts: ResearchOptions = {
    depth,
    projectId,
    urls: Array.isArray(urls) ? urls.filter((u: any) => typeof u === 'string' && u.startsWith('http')) : undefined,
    previousReport,
    previousPapers,
    previousArticles,
    previousScrapedUrls,
    previousSubQuestions,
    isFollowUp,
    confirmedSubQuestions: Array.isArray(confirmedSubQuestions) ? confirmedSubQuestions : undefined,
    decomposeOnly: !!decomposeOnly,
    locale,
    citationStyle,
  };
  const generator = streamResearch(question, opts, context, signal);
  return createSSEResponse(generator, signal);
}
