/**
 * Project store helpers — agent-side counterpart of cloud-functions/project/index.ts.
 *
 * Why duplicate the storage helpers across two runtimes?
 * The agent runtime (this file) and the cloud-function runtime
 * (cloud-functions/project/index.ts) sit on different entry points and
 * cannot share imports. We deliberately mirror the helpers here so:
 *   - the agent writes versions directly via `context.store` (fast, no HTTP)
 *   - the frontend reads versions via the /project cloud-function HTTP route
 * Both sides agree on key naming (`project-{id}-meta`, `project-{id}-v{N}`,
 * `projects-index`) and JSON shape — keep them aligned by hand if anything
 * changes.
 *
 * Storage strategy: each (projectId, key) is one conversationId. We
 * `appendMessage` a new record on every write and `getMessages(limit: 1, order: desc)`
 * on every read. We never call `clearMessages + appendMessage` to simulate a
 * KV (SOP H-163 forbids that pattern). The latest record is always the
 * "current" snapshot; older records are kept as an audit trail.
 */
import { createLogger } from './_shared';

const logger = createLogger('project-store');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
}

export interface ProjectIndex {
  projects: Array<{ id: string; name: string; createdAt: string; versionCount: number }>;
}

// ─── Low-level helpers (single-key per conversationId) ───────────────────────

/**
 * Read the latest snapshot for `key`. With `appendMessage` we keep history
 * on every write; the latest record is the current value.
 */
async function pStoreGet(store: any, key: string): Promise<any> {
  const messages = await store.getMessages({ conversationId: key, limit: 1, order: 'desc' });
  if (messages.length > 0 && messages[0].content) {
    const content = messages[0].content;
    return typeof content === 'string' ? JSON.parse(content) : content;
  }
  return null;
}

/**
 * Append a new snapshot record for `key`. We do NOT clearMessages here;
 * the next `pStoreGet` will read this latest record as the current value,
 * while older records remain as audit history.
 */
async function pStoreSet(store: any, key: string, data: unknown, metadataType?: string): Promise<void> {
  await store.appendMessage({
    conversationId: key,
    role: 'system',
    content: JSON.stringify(data),
    ...(metadataType ? { metadata: { type: metadataType, ts: new Date().toISOString() } } : {}),
  });
}

// ─── High-level operations ───────────────────────────────────────────────────

/**
 * Save a research version directly to the agent's store. Returns the new
 * version number on success, or null if the project meta doesn't exist or
 * any storage error occurs (errors are logged, never thrown — the caller
 * should fall back to the frontend-side save path).
 */
export async function saveVersionToStore(
  store: any,
  projectId: string,
  versionData: any,
): Promise<number | null> {
  try {
    const meta = (await pStoreGet(store, `project-${projectId}-meta`)) as ProjectMeta | null;
    if (!meta) {
      logger.error(`saveVersionToStore: project meta not found id=${projectId}`);
      return null;
    }

    const newVersion = meta.versionCount + 1;
    const now = new Date().toISOString();
    logger.log(`saveVersionToStore: writing v${newVersion} → key=project-${projectId}-v${newVersion} reportLen=${versionData.report?.length ?? 0} papers=${versionData.papers?.length ?? 0} articles=${versionData.articles?.length ?? 0} trigger=${versionData.trigger}`);

    await pStoreSet(store, `project-${projectId}-v${newVersion}`, {
      ...versionData,
      version: newVersion,
      createdAt: now,
    }, 'project-version');

    meta.versionCount = newVersion;
    meta.updatedAt = now;
    await pStoreSet(store, `project-${projectId}-meta`, meta, 'project-meta');

    const index = (await pStoreGet(store, 'projects-index')) as ProjectIndex | null;
    if (index?.projects) {
      const proj = index.projects.find(p => p.id === projectId);
      if (proj) proj.versionCount = newVersion;
      await pStoreSet(store, 'projects-index', index, 'projects-index');
    } else {
      logger.error('saveVersionToStore: projects-index not found, index not updated');
    }

    logger.log(`saveVersionToStore: done id=${projectId} newVersion=${newVersion}`);
    return newVersion;
  } catch (e: any) {
    logger.error(`saveVersionToStore: error id=${projectId}:`, e?.message || String(e));
    return null;
  }
}

/**
 * Read meta + last version (full data) from the store. Returns null on
 * missing-or-error so the caller can degrade gracefully.
 */
export async function getLastVersionFromStore(
  store: any,
  projectId: string,
): Promise<{ meta: ProjectMeta; version: any } | null> {
  try {
    const meta = (await pStoreGet(store, `project-${projectId}-meta`)) as ProjectMeta | null;
    if (!meta || meta.versionCount <= 0) return null;
    const version = await pStoreGet(store, `project-${projectId}-v${meta.versionCount}`);
    if (!version) return null;
    return { meta, version };
  } catch (e: any) {
    logger.error(`getLastVersionFromStore: error id=${projectId}:`, e?.message || String(e));
    return null;
  }
}

/**
 * Archive a one-off (non-project) standalone report under
 * `standalone-report-{conversationId}`. Failures are swallowed because
 * archiving is non-critical.
 */
export async function archiveStandaloneReport(
  store: any,
  conversationId: string,
  data: {
    question: string;
    depth: string;
    subQuestions: string[];
    papers: any[];
    articles: any[];
    scrapedUrls: any[];
    report: string;
  },
): Promise<void> {
  try {
    const key = `standalone-report-${conversationId}`;
    // We no longer call clearMessages; appendMessage writes a new record so
    // the latest snapshot becomes the current value (multi-record history).
    await store.appendMessage({
      conversationId: key,
      role: 'system',
      content: JSON.stringify({
        ...data,
        createdAt: new Date().toISOString(),
        conversationId,
      }),
      metadata: { type: 'standalone-report', ts: new Date().toISOString() },
    });
    logger.log(`archiveStandaloneReport: stored conversationId=${conversationId}`);
  } catch (e) {
    logger.log(`archiveStandaloneReport: skipped — ${(e as Error).message}`);
  }
}
