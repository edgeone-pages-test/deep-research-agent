import { initChatModel, AIMessageChunk, ToolMessage, tool } from 'langchain';
import { modelRetryMiddleware, modelCallLimitMiddleware, toolRetryMiddleware, toolCallLimitMiddleware } from 'langchain';
import { createDeepAgent } from 'deepagents';
import { z } from 'zod';

type Model = Awaited<ReturnType<typeof initChatModel>>;
type Agent = ReturnType<typeof createDeepAgent>;

interface Env {
  AI_GATEWAY_API_KEY: string;
  AI_GATEWAY_BASE_URL: string;
}

const logger = {
  log(...args: unknown[]) {
    console.log(`[search][${new Date().toISOString()}]`, ...args);
  },
  error(...args: unknown[]) {
    console.error(`[search][${new Date().toISOString()}]`, ...args);
  },
};

// ─── Mock Data ───

const MOCK_ACADEMIC_PAPERS = [
  { title: 'Quantum Error Correction with Surface Codes: A Comprehensive Review', authors: 'Chen, L., Wang, M., & Park, S.', journal: 'Physical Review Letters', year: 2024, doi: '10.1103/PhysRevLett.132.040601', abstract: 'We present a comprehensive review of surface code implementations for quantum error correction, demonstrating a 10x improvement in logical error rates compared to previous approaches.' },
  { title: 'Large Language Models as Research Assistants: Capabilities and Limitations', authors: 'Thompson, R., Garcia, A., & Kim, J.', journal: 'Nature Machine Intelligence', year: 2024, doi: '10.1038/s42256-024-0812-3', abstract: 'This study evaluates the effectiveness of large language models in assisting scientific research, finding significant improvements in literature review efficiency while noting hallucination risks.' },
  { title: 'Transformer Architectures for Scientific Discovery', authors: 'Liu, H., Patel, N., & Brown, K.', journal: 'Science', year: 2025, doi: '10.1126/science.abq1234', abstract: 'We demonstrate novel transformer architectures specifically designed for scientific hypothesis generation, achieving state-of-the-art results on multiple benchmark datasets.' },
  { title: 'Sustainable AI: Environmental Impact of Training Large Models', authors: 'Mueller, F., Santos, P., & Johnson, D.', journal: 'Nature Climate Change', year: 2024, doi: '10.1038/s41558-024-1987-2', abstract: 'Our analysis reveals that the carbon footprint of training large AI models has decreased by 40% through algorithmic efficiency improvements, though total compute continues to grow.' },
  { title: 'Brain-Computer Interfaces: From Laboratory to Clinical Practice', authors: 'Yamamoto, K., Fischer, E., & O\'Brien, T.', journal: 'The Lancet Neurology', year: 2025, doi: '10.1016/S1474-4422(25)00034-1', abstract: 'This review summarizes the transition of brain-computer interfaces from research settings to clinical applications, highlighting recent FDA approvals and patient outcomes.' },
  { title: 'Nuclear Fusion: Progress Toward Commercial Viability', authors: 'Anderson, J., Zhao, W., & Petrov, I.', journal: 'Nature Energy', year: 2025, doi: '10.1038/s41560-025-0145-7', abstract: 'We report on recent breakthroughs in tokamak confinement that bring commercial fusion power within a 15-year horizon, including advances in superconducting magnet technology.' },
  { title: 'Drug Discovery with Graph Neural Networks: A Systematic Review', authors: 'Robinson, S., Lee, C., & Nakamura, H.', journal: 'Journal of Medicinal Chemistry', year: 2024, doi: '10.1021/acs.jmedchem.4c00891', abstract: 'Graph neural networks have accelerated drug candidate identification by 3x while reducing false positive rates in virtual screening by 60%.' },
  { title: 'Advances in Multimodal AI for Healthcare Diagnostics', authors: 'Gupta, R., Williams, T., & Choi, S.', journal: 'The New England Journal of Medicine', year: 2025, doi: '10.1056/NEJMoa2501234', abstract: 'Multimodal AI systems combining imaging, genomics, and clinical data achieve diagnostic accuracy exceeding specialist physicians across 12 medical specialties.' },
];

const MOCK_WEB_ARTICLES = [
  { title: 'The Race to Build a Practical Quantum Computer Enters a New Phase', url: 'https://www.technologyreview.com/2025/quantum-computing-race', source: 'MIT Technology Review', date: '2025-03-15', snippet: 'Major tech companies are now competing to achieve quantum advantage in practical applications, with recent demonstrations in drug discovery and materials science.' },
  { title: 'AI Research Tools Are Changing How Scientists Work', url: 'https://www.nature.com/articles/d41586-025-00892-3', source: 'Nature News', date: '2025-02-28', snippet: 'A growing number of research institutions are adopting AI-powered tools for literature review, hypothesis generation, and experimental design.' },
  { title: 'OpenAI Announces New Research-Focused Model Architecture', url: 'https://openai.com/blog/research-model-2025', source: 'OpenAI Blog', date: '2025-04-01', snippet: 'The new architecture is specifically designed for multi-step reasoning in scientific contexts, with built-in citation tracking and uncertainty quantification.' },
  { title: 'Climate Impact of AI: Industry Report 2025', url: 'https://www.iea.org/reports/ai-energy-2025', source: 'International Energy Agency', date: '2025-01-20', snippet: 'Data centers supporting AI workloads now consume 4% of global electricity, though efficiency improvements have slowed the growth rate significantly.' },
  { title: 'Neuralink Achieves Milestone in Human Brain-Computer Interface Trials', url: 'https://www.reuters.com/technology/neuralink-bci-milestone-2025', source: 'Reuters', date: '2025-03-22', snippet: 'The company reports that participants can now control complex digital interfaces using thought alone, marking a significant advance in assistive technology.' },
  { title: 'Fusion Startup Secures Record $2B Funding Round', url: 'https://www.bloomberg.com/news/fusion-funding-2025', source: 'Bloomberg', date: '2025-02-10', snippet: 'Commonwealth Fusion Systems raises largest-ever private fusion investment, planning to build first commercial-scale reactor by 2030.' },
];

const SYSTEM_PROMPT = `You are a research search assistant. Today's date is ${new Date().toISOString().slice(0, 10)}.
Use the search_academic tool to find relevant academic papers and the search_web tool to find web articles.
After gathering sources, use the synthesize tool to combine findings into a brief summary.
Always search both academic and web sources before synthesizing.`;

let model: Model | null = null;
let agent: Agent | null = null;

const searchAcademic = tool(
  async ({ query, maxResults = 4 }: { query: string; maxResults?: number }) => {
    logger.log(`search_academic: "${query}" (max: ${maxResults})`);
    // Mock: filter papers by relevance (simple keyword match)
    const keywords = query.toLowerCase().split(/\s+/);
    const scored = MOCK_ACADEMIC_PAPERS.map(paper => {
      const text = `${paper.title} ${paper.abstract} ${paper.authors}`.toLowerCase();
      const score = keywords.filter(k => text.includes(k)).length;
      return { ...paper, score };
    }).sort((a, b) => b.score - a.score);
    const results = scored.slice(0, maxResults).map(({ score, ...paper }) => paper);
    return JSON.stringify(results);
  },
  {
    name: 'search_academic',
    description: 'Search academic databases for relevant papers. Returns papers with title, authors, journal, year, doi, and abstract.',
    schema: z.object({
      query: z.string().describe('Search query for academic papers'),
      maxResults: z.number().optional().default(4).describe('Maximum number of results'),
    }),
  }
);

const searchWeb = tool(
  async ({ query, maxResults = 3 }: { query: string; maxResults?: number }) => {
    logger.log(`search_web: "${query}" (max: ${maxResults})`);
    const keywords = query.toLowerCase().split(/\s+/);
    const scored = MOCK_WEB_ARTICLES.map(article => {
      const text = `${article.title} ${article.snippet} ${article.source}`.toLowerCase();
      const score = keywords.filter(k => text.includes(k)).length;
      return { ...article, score };
    }).sort((a, b) => b.score - a.score);
    const results = scored.slice(0, maxResults).map(({ score, ...article }) => article);
    return JSON.stringify(results);
  },
  {
    name: 'search_web',
    description: 'Search the web for relevant articles. Returns articles with title, url, source, date, and snippet.',
    schema: z.object({
      query: z.string().describe('Search query for web articles'),
      maxResults: z.number().optional().default(3).describe('Maximum number of results'),
    }),
  }
);

const synthesize = tool(
  async ({ findings }: { findings: string }) => {
    logger.log(`synthesize: ${findings.slice(0, 100)}...`);
    return `Synthesis complete. The gathered sources have been analyzed and key findings have been integrated. ${findings}`;
  },
  {
    name: 'synthesize',
    description: 'Combine research findings from multiple sources into a coherent summary.',
    schema: z.object({
      findings: z.string().describe('Key findings to synthesize'),
    }),
  }
);

function getEnv(contextEnv: Record<string, string | undefined> | undefined): Env {
  const source = contextEnv ?? {};
  const required = ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'] as const;
  const missing = required.filter((k) => !source[k]?.trim());
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    AI_GATEWAY_API_KEY: source.AI_GATEWAY_API_KEY!,
    AI_GATEWAY_BASE_URL: source.AI_GATEWAY_BASE_URL!,
  };
}

async function getModel(env: Env) {
  if (!model) {
    logger.log('Initializing model...');
    model = await initChatModel(process.env.AI_MODEL || '@Pages/deepseek-v4-flash', {
      modelProvider: 'openai',
      apiKey: env.AI_GATEWAY_API_KEY,
      configuration: { baseURL: env.AI_GATEWAY_BASE_URL },
      temperature: 0,
      timeout: 300_000,
    });
  }
  return model;
}

function getAgent(modelInstance: Model) {
  if (!agent) {
    logger.log('Initializing search agent...');
    agent = createDeepAgent({
      model: modelInstance,
      systemPrompt: SYSTEM_PROMPT,
      tools: [searchAcademic, searchWeb, synthesize],
      middleware: [
        modelRetryMiddleware({ maxRetries: 3 }),
        modelCallLimitMiddleware({ runLimit: 30 }),
        toolRetryMiddleware({ maxRetries: 2, tools: ['search_academic', 'search_web'] }),
        toolCallLimitMiddleware({ toolName: 'search_academic', runLimit: 10 }),
        toolCallLimitMiddleware({ toolName: 'search_web', runLimit: 10 }),
      ],
    });
  }
  return agent;
}

async function* eventStream(agentInstance: Agent, userMessage: string, signal?: AbortSignal): AsyncGenerator<string> {
  try {
    logger.log(`starting stream for: "${userMessage.slice(0, 80)}"`);
    const stream = await agentInstance.stream(
      { messages: [{ role: 'user', content: userMessage }] },
      { streamMode: 'messages', signal }
    );

    for await (const chunk of stream) {
      if (signal?.aborted) break;
      const [message] = chunk;

      if (AIMessageChunk.isInstance(message) && message.tool_call_chunks?.length) {
        for (const tc of message.tool_call_chunks) {
          if (tc.name) {
            yield `data: ${JSON.stringify({ type: 'tool_call', name: tc.name })}\n\n`;
          }
        }
        continue;
      }

      if (ToolMessage.isInstance(message)) {
        yield `data: ${JSON.stringify({ type: 'tool_result', name: message.name, content: message.text?.slice(0, 2000) })}\n\n`;
        continue;
      }

      if (AIMessageChunk.isInstance(message) && message.text) {
        const cleaned = message.text.replace(/\n{3,}/g, '\n\n');
        if (cleaned) {
          yield `data: ${JSON.stringify({ type: 'ai_response', content: cleaned })}\n\n`;
        }
      }
    }
    logger.log('stream completed');
  } catch (e: unknown) {
    const error = e as Error;
    if (error.name !== 'AbortError' && !signal?.aborted) {
      logger.error('error:', error.message);
      yield `data: ${JSON.stringify({ type: 'error_message', content: error.message })}\n\n`;
    }
  }
  yield "data: [DONE]\n\n";
}

export async function onRequest(context: any) {
  const { request, env, conversation_id: conversationId, run_id: runId } = context;
  logger.log('conversationId:', conversationId, 'runId:', runId);

  const { message } = request?.body ?? {};

  if (!message) {
    return new Response('Missing chat message', { status: 400 });
  }

  const signal = request?.signal as AbortSignal | undefined;

  let agentInstance: Agent;
  try {
    const envVars = getEnv(env);
    const modelInstance = await getModel(envVars);
    agentInstance = getAgent(modelInstance);
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }

  const encoder = new TextEncoder();
  const readableStream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`));
        } catch { /* closed */ }
      }, 5_000);

      try {
        for await (const chunk of eventStream(agentInstance, message, signal)) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e) {
        const error = e as Error;
        if (error.name !== 'AbortError' && !signal?.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error_message', content: error.message })}\n\n`));
        }
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() { logger.log('client disconnected'); },
  });

  return new Response(readableStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
