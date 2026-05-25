/**
 * Sandbox Test — Verifies all platform tools (commands, files, browser, code_interpreter).
 *
 * POST /sandbox-test
 * Returns JSON with test results for each tool.
 */
import { createLogger } from './_shared';

const logger = createLogger('sandbox-test');

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}

export async function onRequest(context: any) {
  const results: Record<string, any> = {
    timestamp: new Date().toISOString(),
    conversation_id: context.conversation_id,
    sandbox_available: !!context.sandbox,
    sandbox_env: {
      SANDBOX_API_BASE: !!process.env.SANDBOX_API_BASE,
      SANDBOX_BASE_URL: !!process.env.SANDBOX_BASE_URL,
    },
  };

  // 1. Check context.tools availability
  const allTools = context.tools?.all?.() ?? [];
  const toolNames = allTools.map((t: any) => t.name || t.function?.name || 'unknown');
  results.tools = {
    available: typeof context.tools?.all === 'function',
    count: allTools.length,
    names: toolNames,
  };

  // Helper to execute a platform tool
  async function execTool(name: string, args: Record<string, any>): Promise<any> {
    const tool = allTools.find((t: any) => (t.name || t.function?.name) === name);
    if (!tool) return { error: `Tool "${name}" not found` };
    const execute = tool.execute || tool.handler || tool.invoke;
    if (typeof execute !== 'function') return { error: `Tool "${name}" has no execute method` };
    try {
      const result = await execute.call(tool, args);
      return { success: true, result };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  // 2. Test commands tool
  logger.log('Testing commands tool...');
  results.commands = await execTool('commands', { cmd: 'echo "sandbox-ok" && date && uname -a' });

  // 3. Test files tool — write + read + list + remove
  logger.log('Testing files tool...');
  const testFile = '/tmp/deep-research-test.txt';
  const testContent = `Hello from deep-research-edgeone! ${new Date().toISOString()}`;

  const writeResult = await execTool('files', { op: 'write', path: testFile, content: testContent });
  const readResult = await execTool('files', { op: 'read', path: testFile });
  const listResult = await execTool('files', { op: 'list', path: '/tmp' });
  const removeResult = await execTool('files', { op: 'remove', path: testFile });

  results.files = {
    write: writeResult,
    read: readResult,
    list: listResult.success ? { success: true, fileCount: Array.isArray(listResult.result) ? listResult.result.length : '?' } : listResult,
    remove: removeResult,
  };

  // 4. Test code_interpreter tool
  logger.log('Testing code_interpreter tool...');
  results.code_interpreter = await execTool('code_interpreter', {
    language: 'python',
    code: 'print("hello from sandbox python")\nimport sys\nprint(f"Python version: {sys.version}")',
  });

  // 5. Test browser tool
  logger.log('Testing browser tool...');
  results.browser = await execTool('browser', {
    op: 'fetch',
    url: 'https://httpbin.org/get',
  });

  // 6. Test context.sandbox directly (if available)
  if (context.sandbox) {
    logger.log('Testing context.sandbox.commands.run...');
    try {
      const cmdResult = await context.sandbox.commands.run('echo "direct-sandbox-ok"', { timeout: 10 });
      results.direct_sandbox = { success: true, stdout: cmdResult?.stdout || cmdResult?.output };
    } catch (e: any) {
      results.direct_sandbox = { error: e.message };
    }
  } else {
    results.direct_sandbox = { skipped: 'context.sandbox not available' };
  }

  logger.log('Sandbox test complete');
  return json(results);
}
