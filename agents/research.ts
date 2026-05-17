/**
 * Deep Research Orchestrator
 *
 * Coordinates the research pipeline using EdgeOne Pages platform features:
 * - context.agents.invoke() — calls sub-agents (/decompose, /search-lit, /search-web, /synthesize)
 * - context.store — persists conversation history (Memory API)
 * - @edgeone/pages-blob — archives completed reports
 *
 * Pipeline: Decompose → [HITL Approval] → Search (parallel) → Synthesize → Archive
 *
 * NOTE: After modifying agent files, run `rm -rf .edgeone/agent-node && edgeone dev`
 * to force rebuild the agent bundle.
 */
import { getStore } from '@edgeone/pages-blob';
import { createLogger, createSSEResponse, sseEvent } from './_shared';

const logger = createLogger('research');

// ─── Blob Store ──────────────────────────────────────────────────────────────

function getReportStore() {
    const projectId = process.env.PROJECT_ID;
    const token = process.env.EDGEONE_PAGES_API_TOKEN;
    if (projectId && token) {
        return getStore({ name: 'research-reports', projectId, token });
    }
    try { return getStore('research-reports'); } catch { return null; }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
    const { request, store, agents, tracer, conversation_id } = context;
    const body = request?.body ?? {};
    const { message, question: questionField, depth = 'standard', approved, subQuestions: approvedQuestions } = body;
    const question = message || questionField || '';

    const isResume = approved === true && Array.isArray(approvedQuestions);

    if (!question && !isResume) {
        return new Response(JSON.stringify({ error: 'Missing research question' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }

    const signal = request?.signal as AbortSignal | undefined;

    async function* stream(): AsyncGenerator<string> {
        let subQuestions: string[] = [];
        let papers: any[] = [];
        let articles: any[] = [];
        let report = '';

        try {
            // ═══════════════════════════════════════════════════════════
            // Stage 1: Decompose (via context.agents.invoke)
            // ═══════════════════════════════════════════════════════════
            if (isResume) {
                subQuestions = approvedQuestions;
                logger.log(`Resuming with ${subQuestions.length} approved sub-questions`);
                yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1' });
            } else {
                logger.log(`Starting research: "${question.slice(0, 80)}" (depth: ${depth})`);

                // Save to Memory
                if (store) {
                    try { await store.appendMessage({ conversationId: conversation_id, role: 'user', content: question, metadata: { depth } }); } catch {}
                }

                yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'question-decomposer', id: 'stage-1' });
                yield sseEvent({ type: 'progress', step: 1, total: 4, label: 'Decomposing research question...' });

                // Call /decompose sub-agent
                const decomposeResult = await agents.invoke('/decompose', { question, depth });
                subQuestions = decomposeResult?.subQuestions || [];

                if (subQuestions.length === 0) {
                    subQuestions = [`What is the current state of "${question}"?`, `What are the challenges of "${question}"?`, `What is the future of "${question}"?`];
                }

                logger.log(`Decomposed into ${subQuestions.length} sub-questions`);
                yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1', content: JSON.stringify(subQuestions) });
                yield sseEvent({ type: 'ai_response', content: subQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n'), agent: 'question-decomposer' });

                if (signal?.aborted) return;

                // HITL: emit for user approval
                yield sseEvent({ type: 'hitl_request', stage: 'decompose', data: subQuestions, conversationId: conversation_id });
            }

            if (signal?.aborted) return;

            // ═══════════════════════════════════════════════════════════
            // Stage 2 & 3: Search (parallel via context.agents.invoke)
            // ═══════════════════════════════════════════════════════════
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'literature-searcher', id: 'stage-2' });
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'web-researcher', id: 'stage-3' });
            yield sseEvent({ type: 'progress', step: 2, total: 4, label: 'Searching academic papers & web articles...' });

            // Parallel invocation of two sub-agents
            const [litResult, webResult] = await Promise.all([
                agents.invoke('/search-lit', { subQuestions }),
                agents.invoke('/search-web', { subQuestions }),
            ]);

            papers = litResult?.papers || [];
            articles = webResult?.articles || [];

            logger.log(`Search complete: ${papers.length} papers, ${articles.length} articles`);
            yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'literature-searcher', id: 'stage-2', content: JSON.stringify(papers) });
            yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'web-researcher', id: 'stage-3', content: JSON.stringify(articles) });

            if (signal?.aborted) return;

            // ═══════════════════════════════════════════════════════════
            // Stage 4: Synthesize (via context.agents.invoke)
            // ═══════════════════════════════════════════════════════════
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
            yield sseEvent({ type: 'source_switch', agent: 'synthesizer' });
            yield sseEvent({ type: 'progress', step: 3, total: 4, label: 'Synthesizing research report...' });

            const synthResult = await agents.invoke('/synthesize', { question, subQuestions, papers, articles });
            report = synthResult?.report || '';

            // Stream report in chunks for progressive rendering
            if (report) {
                const chunkSize = 150;
                for (let i = 0; i < report.length; i += chunkSize) {
                    if (signal?.aborted) break;
                    yield sseEvent({ type: 'ai_response', content: report.slice(i, i + chunkSize), agent: 'synthesizer' });
                }
            }

            yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'synthesizer', id: 'stage-4' });
            yield sseEvent({ type: 'progress', step: 4, total: 4, label: 'Research complete' });

            // ═══════════════════════════════════════════════════════════
            // Persist: Memory + Blob
            // ═══════════════════════════════════════════════════════════
            if (store && report) {
                try { await store.appendMessage({ conversationId: conversation_id, role: 'assistant', content: report, metadata: { type: 'research_report' } }); } catch {}
            }

            try {
                const reportStore = getReportStore();
                if (reportStore) {
                    await reportStore.setJSON(`report-${conversation_id}-${Date.now()}`, {
                        question, depth, subQuestions, papers, articles, report,
                        createdAt: new Date().toISOString(), conversationId: conversation_id,
                    });
                    logger.log('Report archived to Blob');
                }
            } catch (e) { logger.log('Blob archive skipped:', (e as Error).message); }

            logger.log('All stages completed');
        } catch (e: unknown) {
            const error = e as Error;
            if (error.name === 'AbortError' || signal?.aborted) {
                // Normal
            } else if (error.message?.includes('terminated')) {
                logger.log('Stream terminated by runtime');
            } else {
                logger.error('Pipeline error:', error.message);
                yield sseEvent({ type: 'error_message', content: error.message });
            }
        }

        yield sseEvent({ type: 'usage', input_tokens: 0, output_tokens: 0, total_tokens: 0 });
        yield "data: [DONE]\n\n";
    }

    return createSSEResponse(stream(), signal);
}
