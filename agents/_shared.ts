/**
 * Shared utilities for deep-research agent (OpenAI Agents SDK).
 *
 * IMPORTANT: this module MUST NOT read process.env. Per SOP C-49, all
 * environment access inside `agents/` and `cloud-functions/` must go
 * through `context.env` (the runtime-injected per-request context). The
 * model client factory below takes `context.env` as a parameter; callers
 * pass `context.env` rather than reading from the global process object.
 *
 * OpenAI Agents tracing is disabled via the SDK API
 * (`setTracingDisabled(true)`), not by mutating process.env (SOP C-51).
 */

import {
  Agent,
  run,
  tool,
  OpenAIChatCompletionsModel,
  OpenAIProvider,
  setDefaultModelProvider,
  setTracingDisabled,
} from "@openai/agents";
import OpenAI from "openai";

export {
  Agent,
  run,
  tool,
};

// Disable OpenAI Agents tracing via the SDK API. This is the supported
// approach; process.env mutation is forbidden by SOP C-51.
let _tracingConfigured = false;
function configureTracingOnce() {
  if (_tracingConfigured) return;
  _tracingConfigured = true;
  try {
    setTracingDisabled(true);
  } catch {
    // SDK may not be present at import time during type-check; ignore.
  }
}
configureTracingOnce();

// ─── Model & Provider ────────────────────────────────────────────────────────

/**
 * Create an OpenAI client bound to a particular request's env.
 * Caller passes `context.env`; we never read process.env here.
 */
function createOpenAIClient(env: Record<string, string | undefined>): OpenAI {
  return new OpenAI({
    apiKey: env.AI_GATEWAY_API_KEY!,
    baseURL: env.AI_GATEWAY_BASE_URL!,
    defaultHeaders: {
      "X-Gateway-Timeout": "600",
    },
  });
}

export function getModel(env: Record<string, string | undefined>): OpenAIChatCompletionsModel {
  const client = createOpenAIClient(env);
  return new OpenAIChatCompletionsModel(
    client,
    "@makers/deepseek-v4-flash",
  );
}

let providerInitialized = false;
export function ensureProvider(env: Record<string, string | undefined>) {
  if (providerInitialized) return;
  const client = createOpenAIClient(env);
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
 * Execute a shell command in the EdgeOne sandbox via `context.sandbox`.
 * Returns { stdout, stderr } or null if sandbox unavailable.
 *
 * NOTE: per SOP G-135 we use the platform-injected sandbox API only. No
 * hand-rolled `/v1/sandbox/*` HTTP fallback, no process.env reads.
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
  return null;
}

/**
 * Fetch a URL by racing the sandbox curl with the runtime's native fetch.
 * Returns the response body text on first success, or null on failure.
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
