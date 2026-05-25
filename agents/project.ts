/**
 * Research Project Management — CRUD for persistent research projects with versioning.
 *
 * POST /project
 * Actions: create, list, get, delete, get_version, diff
 *
 * Blob Storage Schema:
 *   projects-index          → { projects: [{id, name, createdAt, versionCount}] }
 *   project-{id}/meta       → { id, name, createdAt, updatedAt, versionCount }
 *   project-{id}/v{N}       → Full version data (report + sources)
 */
import { getStore } from '@edgeone/pages-blob';
import { createLogger } from './_shared';

const logger = createLogger('project');

function getProjectStore() {
  const projectId = process.env.PROJECT_ID || process.env.EDGEONE_PROJECT_ID || process.env.ProjectId;
  const token = process.env.EDGEONE_PAGES_API_TOKEN;
  if (projectId && token) {
    return getStore({ name: 'research-projects', projectId, token });
  }
  try { return getStore('research-projects'); } catch { return null; }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
}

function generateId(): string {
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { action } = body;

  const store = getProjectStore();
  if (!store) {
    return json({ error: 'Blob storage not available (deploy to EdgeOne Pages for persistence)' }, 503);
  }

  try {
    switch (action) {
      // ─── Create Project ──────────────────────────────────────────────
      case 'create': {
        const { name } = body;
        if (!name || typeof name !== 'string') {
          return json({ error: 'Project name is required' }, 400);
        }

        const id = generateId();
        const now = new Date().toISOString();
        const meta: ProjectMeta = { id, name: name.trim(), createdAt: now, updatedAt: now, versionCount: 0 };

        // Save project meta
        await store.setJSON(`${id}/meta`, meta);

        // Update index
        let index: ProjectIndex = { projects: [] };
        try {
          const existing = await store.get('projects-index', { type: 'json' }) as ProjectIndex | null;
          if (existing?.projects) index = existing;
        } catch {}
        index.projects.unshift({ id, name: meta.name, createdAt: now, versionCount: 0 });
        await store.setJSON('projects-index', index);

        logger.log(`Created project: ${id} "${name}"`);
        return json({ project: meta });
      }

      // ─── List Projects ───────────────────────────────────────────────
      case 'list': {
        let index: ProjectIndex = { projects: [] };
        try {
          const existing = await store.get('projects-index', { type: 'json' }) as ProjectIndex | null;
          if (existing?.projects) index = existing;
        } catch {}
        return json({ projects: index.projects });
      }

      // ─── Get Project (meta + version summaries) ──────────────────────
      case 'get': {
        const { id } = body;
        if (!id) return json({ error: 'Missing project id' }, 400);

        const meta = await store.get(`${id}/meta`, { type: 'json' }) as ProjectMeta | null;
        if (!meta) return json({ error: 'Project not found' }, 404);

        // Get version summaries (without full report content)
        const versions: Array<{ version: number; question: string; trigger: string; createdAt: string }> = [];
        for (let i = 1; i <= meta.versionCount; i++) {
          try {
            const v = await store.get(`${id}/v${i}`, { type: 'json' }) as any;
            if (v) {
              versions.push({
                version: i,
                question: v.question || '',
                trigger: v.trigger || 'initial',
                createdAt: v.createdAt || '',
              });
            }
          } catch {}
        }

        return json({ project: meta, versions });
      }

      // ─── Get Specific Version (full data) ────────────────────────────
      case 'get_version': {
        const { id, version } = body;
        if (!id || !version) return json({ error: 'Missing id or version' }, 400);

        const data = await store.get(`${id}/v${version}`, { type: 'json' });
        if (!data) return json({ error: 'Version not found' }, 404);

        return json({ version: data });
      }

      // ─── Diff (return two versions for client-side diff) ─────────────
      case 'diff': {
        const { id, v1, v2 } = body;
        if (!id || !v1 || !v2) return json({ error: 'Missing id, v1, or v2' }, 400);

        const version1 = await store.get(`${id}/v${v1}`, { type: 'json' }) as any;
        const version2 = await store.get(`${id}/v${v2}`, { type: 'json' }) as any;

        if (!version1 || !version2) return json({ error: 'One or both versions not found' }, 404);

        return json({
          v1: { version: v1, report: version1.report, createdAt: version1.createdAt, question: version1.question },
          v2: { version: v2, report: version2.report, createdAt: version2.createdAt, question: version2.question },
        });
      }

      // ─── Delete Project ──────────────────────────────────────────────
      case 'delete': {
        const { id } = body;
        if (!id) return json({ error: 'Missing project id' }, 400);

        const meta = await store.get(`${id}/meta`, { type: 'json' }) as ProjectMeta | null;
        if (!meta) return json({ error: 'Project not found' }, 404);

        // Delete all versions + meta
        for (let i = 1; i <= meta.versionCount; i++) {
          try { await store.delete(`${id}/v${i}`); } catch {}
        }
        await store.delete(`${id}/meta`);

        // Update index
        try {
          const existing = await store.get('projects-index', { type: 'json' }) as ProjectIndex | null;
          if (existing?.projects) {
            existing.projects = existing.projects.filter(p => p.id !== id);
            await store.setJSON('projects-index', existing);
          }
        } catch {}

        logger.log(`Deleted project: ${id}`);
        return json({ success: true });
      }

      // ─── Save Version (called internally by research.ts) ─────────────
      case 'save_version': {
        const { id, versionData } = body;
        if (!id || !versionData) return json({ error: 'Missing id or versionData' }, 400);

        // Get current meta
        let meta = await store.get(`${id}/meta`, { type: 'json' }) as ProjectMeta | null;
        if (!meta) return json({ error: 'Project not found' }, 404);

        // Increment version
        const newVersion = meta.versionCount + 1;
        const now = new Date().toISOString();

        // Save version data
        await store.setJSON(`${id}/v${newVersion}`, {
          ...versionData,
          version: newVersion,
          createdAt: now,
        });

        // Update meta
        meta.versionCount = newVersion;
        meta.updatedAt = now;
        await store.setJSON(`${id}/meta`, meta);

        // Update index
        try {
          const existing = await store.get('projects-index', { type: 'json' }) as ProjectIndex | null;
          if (existing?.projects) {
            const proj = existing.projects.find(p => p.id === id);
            if (proj) proj.versionCount = newVersion;
            await store.setJSON('projects-index', existing);
          }
        } catch {}

        logger.log(`Saved version ${newVersion} for project ${id}`);
        return json({ success: true, version: newVersion });
      }

      default:
        return json({ error: 'Unknown action. Use: create, list, get, get_version, diff, delete, save_version' }, 400);
    }
  } catch (e) {
    logger.error((e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
}
