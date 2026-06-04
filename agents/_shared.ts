/**
 * Shared utilities for deep-research agent (OpenAI Agents SDK).
 */

// Disable OpenAI Agents tracing (we use EdgeOne's own observability)
process.env.OPENAI_AGENTS_DISABLE_TRACING = 'true';

import {
  Agent,
  run,
  tool,
  OpenAIChatCompletionsModel,
  OpenAIProvider,
  setDefaultModelProvider,
} from "@openai/agents";
import OpenAI from "openai";

export {
  Agent,
  run,
  tool,
};

// ─── Model & Provider ────────────────────────────────────────────────────────

function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.AI_GATEWAY_API_KEY!,
    baseURL: process.env.AI_GATEWAY_BASE_URL!,
    defaultHeaders: {
      "X-Gateway-Timeout": "600",
    },
  });
}

export function getModel(): OpenAIChatCompletionsModel {
  const client = createOpenAIClient();
  return new OpenAIChatCompletionsModel(
    client,
    "@makers/deepseek-v4-flash",
  );
}

let providerInitialized = false;
export function ensureProvider() {
  if (providerInitialized) return;
  const client = createOpenAIClient();
  setDefaultModelProvider(new OpenAIProvider({
    openAIClient: client,
    useResponses: false,
  }));
  providerInitialized = true;
}

// ─── Logger ──────────────────────────────────────────────────────────────────

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

// ─── SSE Helpers ─────────────────────────────────────────────────────────────

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
            encoder.encode(`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`)
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
            encoder.encode(`data: ${JSON.stringify({ type: "error_message", content: error.message })}\n\n`)
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

export function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ─── Sandbox Utilities ───────────────────────────────────────────────────────

const sandboxLogger = createLogger("sandbox");

/**
 * Process-level mutex for sandbox acquire to avoid "ClientToken already being
 * processed" errors when multiple tool calls invoke sandbox concurrently.
 */
let _sandboxInitialized = false;
let _sandboxInitLock: Promise<void> | null = null;

async function ensureSandboxInitialized<T>(fn: () => Promise<T>): Promise<T> {
  if (_sandboxInitialized) return fn();

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
async function sandboxExec(
  context: any,
  command: string,
  timeout = 30_000
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const sandbox = context?.sandbox;
    if (sandbox && typeof sandbox.commands?.run === "function") {
      const result = await ensureSandboxInitialized(() =>
        sandbox.commands.run(command, { timeout })
      ) as any;
      return {
        stdout: result?.stdout ?? result?.output ?? "",
        stderr: result?.stderr ?? "",
      };
    }
  } catch (e: any) {
    if (e?.stdout || e?.stderr || e?.output) {
      sandboxLogger.log("sandbox.commands.run non-zero exit:", e.message);
      return {
        stdout: e.stdout ?? e.output ?? "",
        stderr: e.stderr ?? "",
      };
    }
    sandboxLogger.log("sandbox.commands.run failed:", e.message);
  }

  // Fallback: call sandbox HTTP API directly
  const baseUrl = process.env.SANDBOX_API_BASE || process.env.SANDBOX_BASE_URL;
  const conversationId = context?.conversation_id;
  if (!baseUrl) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout + 5_000);
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(conversationId ? { "makers-conversation-id": conversationId } : {}),
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
 * Fetch a URL: race sandbox curl and runtime fetch in parallel.
 * Returns response body text or null on failure.
 */
export async function safeFetch(
  context: any,
  url: string,
  options?: { timeout?: number; headers?: Record<string, string> }
): Promise<string | null> {
  const timeout = options?.timeout ?? 15_000;

  const sandboxFetch = async (): Promise<string | null> => {
    const headerArgs = Object.entries(options?.headers ?? {})
      .map(([k, v]) => `-H '${k}: ${v}'`)
      .join(" ");
    const curlCmd = `curl -sS --max-time ${Math.floor(timeout / 1000)} ${headerArgs} '${url}'`;
    const result = await sandboxExec(context, curlCmd, timeout + 5_000);
    return result?.stdout || null;
  };

  const runtimeFetch = async (): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: options?.headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      clearTimeout(timer);
      return null;
    }
  };

  const result = await new Promise<{ data: string; source: string } | null>((resolve) => {
    let settled = false;
    let pending = 2;

    const tryResolve = (value: string | null, source: string) => {
      if (settled) return;
      if (value) {
        settled = true;
        resolve({ data: value, source });
      } else {
        pending--;
        if (pending === 0) {
          settled = true;
          resolve(null);
        }
      }
    };

    sandboxFetch().then((v) => tryResolve(v, 'sandbox'), () => tryResolve(null, 'sandbox'));
    runtimeFetch().then((v) => tryResolve(v, 'runtime'), () => tryResolve(null, 'runtime'));
  });

  if (!result) {
    sandboxLogger.log("safeFetch: both strategies failed for", url);
    return null;
  }
  sandboxLogger.log(`safeFetch: winner=${result.source} url=${url.slice(0, 80)}`);
  return result.data;
}
