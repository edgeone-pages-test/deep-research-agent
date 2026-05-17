/**
 * Research History — CRUD for archived research reports (Blob storage).
 *
 * Actions: list, get, delete
 */
import { getStore } from '@edgeone/pages-blob';
import { createLogger } from './_shared';

const logger = createLogger('history');

function getReportStore() {
    const projectId = process.env.PROJECT_ID;
    const token = process.env.EDGEONE_PAGES_API_TOKEN;
    if (projectId && token) {
        return getStore({ name: 'research-reports', projectId, token });
    }
    // In Pages environment, auto-auth works without config
    try {
        return getStore('research-reports');
    } catch {
        return null;
    }
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
}

export async function onRequest(context: any) {
    const { request } = context;
    const { action } = request?.body ?? {};

    try {
        const store = getReportStore();
        if (!store) {
            return json({ error: 'Blob storage not available (local dev — deploy to EdgeOne Pages for persistence)' }, 503);
        }

        switch (action) {
            case 'list': {
                const result = await store.list({ prefix: 'report-' });
                const reports: Array<{ id: string; question: string; depth: string; createdAt: string }> = [];
                for (const item of (result as any).blobs || []) {
                    try {
                        const data = await store.get(item.key, { type: 'json' }) as any;
                        if (data) {
                            reports.push({
                                id: item.key,
                                question: data.question || '',
                                depth: data.depth || 'standard',
                                createdAt: data.createdAt || '',
                            });
                        }
                    } catch {}
                }
                reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                return json({ reports });
            }

            case 'get': {
                const { id } = request?.body ?? {};
                if (!id) return json({ error: 'Missing id' }, 400);
                const data = await store.get(id, { type: 'json' });
                if (!data) return json({ error: 'Report not found' }, 404);
                return json({ report: data });
            }

            case 'delete': {
                const { id } = request?.body ?? {};
                if (!id) return json({ error: 'Missing id' }, 400);
                await store.delete(id);
                logger.log('Deleted report:', id);
                return json({ success: true });
            }

            default:
                return json({ error: 'Unknown action. Use: list, get, delete' }, 400);
        }
    } catch (e) {
        logger.error((e as Error).message);
        return json({ error: (e as Error).message }, 500);
    }
}
