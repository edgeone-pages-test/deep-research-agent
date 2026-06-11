/**
 * Health probe — EdgeOne Makers Node Function.
 *
 * File path `cloud-functions/health/index.ts` maps to **GET /health**.
 *
 * Purely diagnostic: no AI runtime usage, so it lives in cloud-functions
 * rather than agents/ (matches the openai-agents-test layout).
 */
export async function onRequest(context: any): Promise<Response> {
  const data = {
    status: 'ok',
    runId: context.run_id ?? context.agent?.run_id ?? null,
    env: context.env ?? null,
  };

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}
