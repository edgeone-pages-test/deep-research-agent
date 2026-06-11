/**
 * Shared HTTP helpers for cloud-functions handlers.
 *
 * Cloud-functions can't reuse agents/_shared.ts (which imports the OpenAI
 * Agents SDK). These wrappers handle JSON I/O the way the EdgeOne Makers
 * Node Functions runtime expects — see https://pages.edgeone.ai/document/node-functions
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export async function readJsonBody(context: any): Promise<Record<string, unknown>> {
  try {
    const data = await context.request.json();
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
