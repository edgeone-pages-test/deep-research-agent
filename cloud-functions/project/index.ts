/**
 * Research Project Management — CRUD for persistent research projects.
 *
 * EdgeOne Pages Node Function. File path
 * `cloud-functions/project/index.ts` maps to **POST /project**.
 *
 * This file moved out of `agents/` because nothing here uses the AI runtime
 * (no model calls, no agent SDK) — it's pure storage CRUD over the same
 * `context.agent.store` that the agents in `agents/` write to. Splitting AI
 * vs. non-AI endpoints into `agents/` vs. `cloud-functions/` matches the
 * EdgeOne Pages template conventions used by openai-agents-test and
 * csv-analyze-agent.
 *
 * Actions: create, list, get, delete, get_version, diff,
 *          save_version, save_chat, get_chat
 *
 * Storage layout (each conversationId is one logical record):
 *   projects-index          → manifest: [{ id, name, createdAt, versionCount }]
 *   project-{id}-meta       → { id, name, createdAt, updatedAt, versionCount }
 *   project-{id}-v{N}       → Full version data (report + sources)
 *   project-{id}-chat       → { messages, updatedAt }
 *
 * Note: `agents/research.ts` writes versions to the same store using
 * `context.store` directly (see _project-store.ts logic mirrored there).
 */
import { createLogger } from '../_logger';
import { jsonResponse, errorResponse, readJsonBody } from '../_http';

const logger = createLogger('project');

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function storeGet(store: any, key: string): Promise<any> {
  const messages = await store.getMessages({ conversationId: key, limit: 1, order: 'desc' });
  if (messages.length > 0 && messages[0].content) {
    const content = messages[0].content;
    return typeof content === 'string' ? JSON.parse(content) : content;
  }
  return null;
}

async function storeSet(store: any, key: string, data: unknown, metadataType?: string): Promise<void> {
  // We no longer use the `clearMessages + appendMessage` pattern (forbidden
  // by SOP H-163). Each write appendMessage's a new record; `storeGet` reads
  // the latest; older records stay as an audit trail.
  await store.appendMessage({
    conversationId: key,
    role: 'system',
    content: JSON.stringify(data),
    ...(metadataType ? { metadata: { type: metadataType, ts: new Date().toISOString() } } : {}),
  });
}

async function storeDel(store: any, key: string): Promise<void> {
  try { await store.clearMessages({ conversationId: key }); } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
}

interface ProjectIndex {
  projects: Array<{ id: string; name: string; createdAt: string; versionCount: number }>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function onRequestPost(context: any): Promise<Response> {
  const body = await readJsonBody(context);
  const action = typeof body.action === 'string' ? body.action : '';
  // Cloud-functions read the agent-attached store via context.agent.store
  // (context.store doesn't exist here — that's the agents/ runtime).
  const store = context.agent?.store ?? null;

  logger.log(`→ action=${action || '(missing)'}`);

  if (!store) {
    logger.error('store not available — context.agent.store is null. Not running on EdgeOne Pages?');
    return errorResponse('Storage not available (deploy to EdgeOne Pages)', 503);
  }

  try {
    switch (action) {
      // ─── Create Project ──────────────────────────────────────────────
      case 'create': {
        const name = body.name;
        if (!name || typeof name !== 'string') {
          logger.error('create: missing or invalid name');
          return errorResponse('Project name is required', 400);
        }

        const id = generateId();
        const now = new Date().toISOString();
        const meta: ProjectMeta = { id, name: name.trim(), createdAt: now, updatedAt: now, versionCount: 0 };

        logger.log(`create: writing meta → key=project-${id}-meta name="${meta.name}"`);
        await storeSet(store, `project-${id}-meta`, meta, 'project-meta');

        const index: ProjectIndex = (await storeGet(store, 'projects-index')) || { projects: [] };
        logger.log(`create: projects-index had ${index.projects.length} entries, prepending new project`);
        index.projects.unshift({ id, name: meta.name, createdAt: now, versionCount: 0 });
        await storeSet(store, 'projects-index', index, 'projects-index');

        logger.log(`create: done — id=${id} total_projects=${index.projects.length}`);
        return jsonResponse({ project: meta });
      }

      // ─── List Projects ───────────────────────────────────────────────
      case 'list': {
        logger.log('list: reading projects-index');
        const index: ProjectIndex = (await storeGet(store, 'projects-index')) || { projects: [] };
        logger.log(`list: found ${index.projects.length} projects → [${index.projects.map(p => p.id).join(', ')}]`);
        return jsonResponse({ projects: index.projects });
      }

      // ─── Get Project (meta + version summaries) ──────────────────────
      case 'get': {
        const id = body.id as string | undefined;
        if (!id) {
          logger.error('get: missing id');
          return errorResponse('Missing project id', 400);
        }
        logger.log(`get: reading meta → key=project-${id}-meta`);
        const meta = await storeGet(store, `project-${id}-meta`) as ProjectMeta | null;
        if (!meta) {
          logger.error(`get: project not found id=${id}`);
          return errorResponse('Project not found', 404);
        }
        logger.log(`get: meta found name="${meta.name}" versionCount=${meta.versionCount}`);

        const versions: Array<{ version: number; question: string; trigger: string; createdAt: string }> = [];
        for (let i = 1; i <= meta.versionCount; i++) {
          logger.log(`get: reading version summary → key=project-${id}-v${i}`);
          const v = await storeGet(store, `project-${id}-v${i}`);
          if (v) {
            versions.push({ version: i, question: v.question || '', trigger: v.trigger || 'initial', createdAt: v.createdAt || '' });
          } else {
            logger.error(`get: version ${i} key not found (data loss?) id=${id}`);
          }
        }
        logger.log(`get: returning ${versions.length}/${meta.versionCount} version summaries for id=${id}`);
        return jsonResponse({ project: meta, versions });
      }

      // ─── Get Specific Version (full data) ────────────────────────────
      case 'get_version': {
        const id = body.id as string | undefined;
        const version = body.version;
        if (!id || !version) {
          logger.error(`get_version: missing params id=${id} version=${version}`);
          return errorResponse('Missing id or version', 400);
        }
        logger.log(`get_version: reading → key=project-${id}-v${version}`);
        const data = await storeGet(store, `project-${id}-v${version}`);
        if (!data) {
          logger.error(`get_version: not found id=${id} version=${version}`);
          return errorResponse('Version not found', 404);
        }
        logger.log(`get_version: found id=${id} v${version} reportLen=${data.report?.length ?? 0} papers=${data.papers?.length ?? 0} articles=${data.articles?.length ?? 0}`);
        return jsonResponse({ version: data });
      }

      // ─── Diff (return two versions for client-side diff) ─────────────
      case 'diff': {
        const id = body.id as string | undefined;
        const v1 = body.v1;
        const v2 = body.v2;
        if (!id || !v1 || !v2) {
          logger.error(`diff: missing params id=${id} v1=${v1} v2=${v2}`);
          return errorResponse('Missing id, v1, or v2', 400);
        }
        logger.log(`diff: reading → project-${id}-v${v1} and project-${id}-v${v2}`);
        const version1 = await storeGet(store, `project-${id}-v${v1}`);
        const version2 = await storeGet(store, `project-${id}-v${v2}`);
        if (!version1 || !version2) {
          logger.error(`diff: version(s) not found id=${id} v1_found=${!!version1} v2_found=${!!version2}`);
          return errorResponse('One or both versions not found', 404);
        }
        logger.log(`diff: ok id=${id} v${v1}(${version1.report?.length ?? 0}chars) vs v${v2}(${version2.report?.length ?? 0}chars)`);
        return jsonResponse({
          v1: { version: v1, report: version1.report, createdAt: version1.createdAt, question: version1.question },
          v2: { version: v2, report: version2.report, createdAt: version2.createdAt, question: version2.question },
        });
      }

      // ─── Delete Project ──────────────────────────────────────────────
      case 'delete': {
        const id = body.id as string | undefined;
        if (!id) {
          logger.error('delete: missing id');
          return errorResponse('Missing project id', 400);
        }
        logger.log(`delete: reading meta → key=project-${id}-meta`);
        const meta = await storeGet(store, `project-${id}-meta`) as ProjectMeta | null;
        if (!meta) {
          logger.error(`delete: project not found id=${id}`);
          return errorResponse('Project not found', 404);
        }
        logger.log(`delete: deleting ${meta.versionCount} version(s) + meta + chat for id=${id}`);
        for (let i = 1; i <= meta.versionCount; i++) {
          await storeDel(store, `project-${id}-v${i}`);
        }
        await storeDel(store, `project-${id}-meta`);
        await storeDel(store, `project-${id}-chat`);

        const index = await storeGet(store, 'projects-index') as ProjectIndex | null;
        if (index?.projects) {
          const before = index.projects.length;
          index.projects = index.projects.filter(p => p.id !== id);
          logger.log(`delete: index updated ${before} → ${index.projects.length} projects`);
          await storeSet(store, 'projects-index', index, 'projects-index');
        }
        logger.log(`delete: done id=${id}`);
        return jsonResponse({ success: true });
      }

      // ─── Save Version (also called by agents/research.ts via fetch fallback) ─
      case 'save_version': {
        const id = body.id as string | undefined;
        const versionData = body.versionData as any;
        if (!id || !versionData) {
          logger.error(`save_version: missing params id=${id} hasVersionData=${!!versionData}`);
          return errorResponse('Missing id or versionData', 400);
        }
        logger.log(`save_version: reading meta → key=project-${id}-meta`);
        const meta = await storeGet(store, `project-${id}-meta`) as ProjectMeta | null;
        if (!meta) {
          logger.error(`save_version: project not found id=${id}`);
          return errorResponse('Project not found', 404);
        }

        const newVersion = meta.versionCount + 1;
        const now = new Date().toISOString();
        logger.log(`save_version: writing v${newVersion} → key=project-${id}-v${newVersion} reportLen=${versionData.report?.length ?? 0} papers=${versionData.papers?.length ?? 0} articles=${versionData.articles?.length ?? 0} trigger=${versionData.trigger}`);

        await storeSet(store, `project-${id}-v${newVersion}`, {
          ...versionData,
          version: newVersion,
          createdAt: now,
        }, 'project-version');

        meta.versionCount = newVersion;
        meta.updatedAt = now;
        logger.log(`save_version: updating meta versionCount=${newVersion}`);
        await storeSet(store, `project-${id}-meta`, meta, 'project-meta');

        const index = await storeGet(store, 'projects-index') as ProjectIndex | null;
        if (index?.projects) {
          const proj = index.projects.find(p => p.id === id);
          if (proj) {
            proj.versionCount = newVersion;
            logger.log(`save_version: updating index entry for id=${id}`);
          } else {
            logger.error(`save_version: id=${id} not found in projects-index (index out of sync)`);
          }
          await storeSet(store, 'projects-index', index, 'projects-index');
        } else {
          logger.error('save_version: projects-index not found, index not updated');
        }

        logger.log(`save_version: done id=${id} newVersion=${newVersion}`);
        return jsonResponse({ success: true, version: newVersion });
      }

      // ─── Save Chat History ────────────────────────────────────────────
      case 'save_chat': {
        const id = body.id as string | undefined;
        const messages = body.messages;
        if (!id || !Array.isArray(messages)) {
          logger.error(`save_chat: missing params id=${id} messages_is_array=${Array.isArray(messages)}`);
          return errorResponse('Missing id or messages', 400);
        }
        logger.log(`save_chat: writing ${messages.length} message(s) → key=project-${id}-chat`);
        await storeSet(store, `project-${id}-chat`, { messages, updatedAt: new Date().toISOString() }, 'project-chat');
        logger.log(`save_chat: done id=${id}`);
        return jsonResponse({ success: true });
      }

      // ─── Get Chat History ─────────────────────────────────────────────
      case 'get_chat': {
        const id = body.id as string | undefined;
        if (!id) {
          logger.error('get_chat: missing id');
          return errorResponse('Missing id', 400);
        }
        logger.log(`get_chat: reading → key=project-${id}-chat`);
        const chatData = await storeGet(store, `project-${id}-chat`);
        const count = chatData?.messages?.length ?? 0;
        logger.log(`get_chat: found ${count} message(s) id=${id}`);
        return jsonResponse({ messages: chatData?.messages || [] });
      }

      default:
        logger.error(`unknown action="${action}"`);
        return errorResponse('Unknown action. Use: create, list, get, get_version, diff, delete, save_version, save_chat, get_chat', 400);
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    const isStorageError =
      e?.code === 'CREDENTIAL_ERROR' ||
      msg.includes('credential') ||
      msg.includes('Invalid project') ||
      msg.includes('Memory storage operation failed');
    if (isStorageError) {
      logger.error(`storage error (action=${action}):`, msg);
      return errorResponse('Storage not available (deploy to EdgeOne Pages)', 503);
    }
    logger.error(`unhandled error (action=${action}):`, msg);
    return errorResponse(msg, 500);
  }
}
