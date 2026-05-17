/**
 * Decompose Sub-Agent — Breaks research question into sub-questions.
 *
 * Uses direct model.invoke() for fast response.
 * Called by orchestrator via context.agents.invoke('/decompose', payload).
 */
import { createModel, createLogger } from './_shared';
import { HumanMessage } from '@langchain/core/messages';

const logger = createLogger('decompose');

const SYSTEM_PROMPT = `You are a research methodologist. Break down the research question into focused, independently researchable sub-questions.

Rules:
- For "quick" depth: generate 2-3 sub-questions
- For "standard" depth: generate 3-5 sub-questions
- For "deep" depth: generate 5-7 sub-questions
- Each sub-question should explore a different aspect (background, current state, challenges, future, comparisons)
- IMPORTANT: Generate sub-questions in the SAME LANGUAGE as the input question
- Output ONLY a JSON array of strings, no markdown fences, no explanations

Example (English input): ["What is the current state of X?", "What challenges does X face?"]
Example (Chinese input): ["X的当前发展状况如何？", "X面临哪些主要挑战？"]`;

export async function onRequest(context: any) {
    const { request } = context;
    const { question, depth = 'standard' } = request?.body ?? {};

    if (!question) {
        return new Response(JSON.stringify({ error: 'Missing question' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        logger.log(`Decomposing: "${question.slice(0, 80)}" (depth: ${depth})`);

        const model = createModel();
        const response = await model.invoke([
            { role: 'system', content: SYSTEM_PROMPT },
            new HumanMessage(`Research question: "${question}"\nDepth: ${depth}\n\nGenerate sub-questions as a JSON array.`),
        ]);

        const content = typeof response.content === 'string' ? response.content : '';
        let subQuestions: string[] = [];

        let jsonStr = content.trim();
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

        try {
            const parsed = JSON.parse(jsonStr);
            if (Array.isArray(parsed)) subQuestions = parsed;
        } catch {
            const match = content.match(/\[[\s\S]*\]/);
            if (match) { try { subQuestions = JSON.parse(match[0]); } catch {} }
        }

        if (subQuestions.length === 0) {
            subQuestions = [
                `What is the current state of "${question}"?`,
                `What are the main challenges related to "${question}"?`,
                `What are future directions for "${question}"?`,
            ];
        }

        logger.log(`Generated ${subQuestions.length} sub-questions`);
        return new Response(JSON.stringify({ subQuestions }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        logger.error((e as Error).message);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}
