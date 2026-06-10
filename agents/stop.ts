/**
 * Stop handler — aborts the running research/chat agent for this conversation.
 *
 * IMPORTANT: the stop request MUST NOT carry the same `makers-conversation-id`
 * header as the chat request, otherwise EdgeOne sticky-routes /stop to the
 * busy chat instance and abortActiveRun() never reaches the runner.
 * The target conversation_id is therefore read from the request body, with
 * header fallback only as a defensive last resort.
 */

const logger = {
  log(...args: unknown[]) {
    console.log(`[stop][${new Date().toISOString()}]`, ...args);
  },
  error(...args: unknown[]) {
    console.error(`[stop][${new Date().toISOString()}]`, ...args);
  },
};

export async function onRequest(context: any) {
  // /stop endpoint: the frontend MUST pass conversation_id via the body
  // (never carry the header). Body wins; runtime-injected
  // context.conversation_id acts as a fallback.
  const { request } = context;
  const body = (request?.body ?? {}) as Record<string, unknown>;
  const conversationId =
    (body.conversation_id as string | undefined) ??
    (body.conversationId as string | undefined) ??
    context.conversation_id;

  if (!conversationId) {
    logger.error('Missing conversation_id');
    return new Response('Missing conversation_id', { status: 400 });
  }

  const ret = context.utils.abortActiveRun(conversationId);
  logger.log('abortActiveRun result:', ret);

  const data = {
    status: ret?.aborted ? 'aborting' : 'idle',
    conversationId,
    ...ret,
  };

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}
