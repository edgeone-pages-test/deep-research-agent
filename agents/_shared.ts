/**
 * Shared utilities for deep-research agent endpoints.
 * Uses ChatOpenAI directly (avoids initChatModel OPENAI_API_KEY env check).
 */
import { ChatOpenAI } from "@langchain/openai";

/**
 * Create model instance. Cached per process.
 */
let cachedModel: ChatOpenAI | null = null;

export function createModel(): ChatOpenAI {
  if (cachedModel) return cachedModel;

  cachedModel = new ChatOpenAI({
    model: process.env.AI_MODEL || "@Pages/deepseek-v4-flash",
    apiKey: process.env.AI_GATEWAY_API_KEY!,
    configuration: {
      baseURL: process.env.AI_GATEWAY_BASE_URL!,
    },
    timeout: 300_000,
  });

  return cachedModel;
}

/**
 * Logger with timestamp prefix.
 */
export function createLogger(name: string) {
  return {
    log(...args: unknown[]) {
      console.log(`[${name}][${new Date().toISOString()}]`, ...args);
    },
    error(...args: unknown[]) {
      console.error(`[${name}][${new Date().toISOString()}]`, ...args);
    },
  };
}

/**
 * Create SSE Response from an async generator.
 */
export function createSSEResponse(
  generator: AsyncGenerator<string>,
  signal?: AbortSignal
): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`
            )
          );
        } catch {}
      }, 5_000);
      try {
        for await (const chunk of generator) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e) {
        const error = e as Error;
        if (error.name !== "AbortError" && !signal?.aborted) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error_message",
                content: error.message,
              })}\n\n`
            )
          );
        }
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() {},
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Helper: emit an SSE data line.
 */
export function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ─── Sandbox Utilities ──────────────────────────────────────────────────────

const sandboxLogger = createLogger("sandbox");

/**
 * Process-level mutex for sandbox acquire to avoid "ClientToken already being
 * processed" errors when multiple sub-agents invoke sandbox concurrently.
 *
 * Root cause: each sub-agent context creates a separate LazySandbox with its
 * own InstanceCache, causing duplicate acquire requests for the same
 * conversation. This lock serializes the FIRST sandbox call so that the
 * second sub-agent waits for the first acquire to complete. Once acquired,
 * subsequent calls proceed concurrently (the backend returns the cached instance).
 */
let _sandboxInitialized = false;
let _sandboxInitLock: Promise<void> | null = null;

async function ensureSandboxInitialized<T>(fn: () => Promise<T>): Promise<T> {
  if (_sandboxInitialized) return fn();

  // First caller acquires the lock
  if (_sandboxInitLock) {
    await _sandboxInitLock;
    return fn();
  }

  let resolve: () => void;
  _sandboxInitLock = new Promise<void>((r) => { resolve = r; });
  try {
    const result = await fn();
    _sandboxInitialized = true;
    return result;
  } finally {
    _sandboxInitLock = null;
    resolve!();
  }
}

/**
 * Execute a shell command in the remote sandbox.
 * Returns { stdout, stderr } or null if sandbox unavailable.
 */
export async function sandboxExec(
  context: any,
  command: string,
  timeout = 30_000
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const sandbox = context?.sandbox;
    if (sandbox && typeof sandbox.commands?.run === "function") {
      const result = await ensureSandboxInitialized(() =>
        sandbox.commands.run(command, { timeout })
      );
      return {
        stdout: result?.stdout ?? result?.output ?? "",
        stderr: result?.stderr ?? "",
      };
    }
  } catch (e) {
    sandboxLogger.log("sandbox.commands.run failed:", (e as Error).message);
  }

  // Fallback: call sandbox HTTP API directly via env vars
  const baseUrl =
    process.env.SANDBOX_API_BASE || process.env.SANDBOX_BASE_URL;
  const conversationId = context?.conversation_id;
  if (!baseUrl) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout + 5_000);
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(conversationId
          ? { "pages-agent-conversation-id": conversationId }
          : {}),
      },
      body: JSON.stringify({ command, timeout: Math.floor(timeout / 1000) }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      stdout: data?.data?.output ?? data?.output ?? data?.stdout ?? "",
      stderr: data?.data?.stderr ?? data?.stderr ?? "",
    };
  } catch (e) {
    sandboxLogger.log("sandbox HTTP fallback failed:", (e as Error).message);
    return null;
  }
}

/**
 * Fetch a URL: try sandbox curl first, fallback to runtime fetch.
 * Returns response body text or null on failure.
 */
export async function safeFetch(
  context: any,
  url: string,
  options?: { timeout?: number; headers?: Record<string, string> }
): Promise<string | null> {
  const timeout = options?.timeout ?? 15_000;
  const headerArgs = Object.entries(options?.headers ?? {})
    .map(([k, v]) => `-H '${k}: ${v}'`)
    .join(" ");

  // 1) Sandbox curl
  const curlCmd = `curl -sS --max-time ${Math.floor(timeout / 1000)} ${headerArgs} '${url}'`;
  const sandboxResult = await sandboxExec(context, curlCmd, timeout + 5_000);
  if (sandboxResult?.stdout) return sandboxResult.stdout;

  // 2) Runtime fetch
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      headers: options?.headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    sandboxLogger.log("runtime fetch failed:", (e as Error).message);
    return null;
  }
}
