import { initChatModel } from "langchain";
import { modelRetryMiddleware, modelCallLimitMiddleware } from "langchain";
import { createDeepAgent } from "deepagents";

type Model = Awaited<ReturnType<typeof initChatModel>>;
type Agent = ReturnType<typeof createDeepAgent>;

const logger = {
    log(...args: unknown[]) { console.log(`[test][${new Date().toISOString()}]`, ...args); },
    error(...args: unknown[]) { console.error(`[test][${new Date().toISOString()}]`, ...args); },
};

let model: Model | null = null;
let agent: Agent | null = null;

async function getModel(env: any) {
    if (!model) {
        const modelName = process.env.AI_MODEL || "@Pages/deepseek-v4-flash";
        logger.log("Using model:", modelName);
        model = await initChatModel(modelName, {
            modelProvider: "openai",
            apiKey: env.AI_GATEWAY_API_KEY,
            configuration: { baseURL: env.AI_GATEWAY_BASE_URL },
            temperature: 0,
            timeout: 60_000,
        });
    }
    return model;
}

function getAgent(m: Model) {
    if (!agent) {
        agent = createDeepAgent({
            model: m,
            systemPrompt: "You are a test assistant. Reply with a short sentence to confirm you are working.",
            middleware: [
                modelRetryMiddleware({ maxRetries: 2 }),
                modelCallLimitMiddleware({ runLimit: 5 }),
            ],
        });
    }
    return agent;
}

export async function onRequest(context: any) {
    const { request, env } = context;
    const { message } = request?.body ?? {};
    logger.log("test message:", message);

    if (!message) {
        return new Response(JSON.stringify({ error: "Missing message" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        const m = await getModel(env);
        const a = getAgent(m);

        logger.log("Calling invoke (no tools, no streaming)...");
        const result = await a.invoke(
            { messages: [{ role: "user", content: message }] },
        );
        const messages = (result as any).messages;
        const reply = messages[messages.length - 1].content;
        logger.log("Reply:", reply);

        return new Response(JSON.stringify({ status: "ok", model: process.env.AI_MODEL || "@Pages/deepseek-v4-flash", reply }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (e: any) {
        logger.error("Error:", e.message);
        return new Response(JSON.stringify({ status: "error", model: process.env.AI_MODEL || "@Pages/deepseek-v4-flash", error: e.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}

