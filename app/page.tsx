'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { ResearchForm } from './components/research-form';
import { ProgressTree } from './components/progress-tree';
import { SourcesPanel } from './components/sources-panel';
import { ReportView } from './components/report-view';
import { ProjectSelector } from './components/project-selector';
import { FollowUpChat } from './components/follow-up-chat';
import { VersionSelector } from './components/version-selector';
import { DiffView } from './components/diff-view';
import { SubQuestionConfirm } from './components/sub-question-confirm';
import { DeployButtons } from './components/deploy-buttons';
import { CitationCoverage } from './components/citation-coverage';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { TokenUsage } from '@/components/ui/token-usage';
import { useI18n } from '@/lib/i18n';
import { normalizeAuthors } from '@/lib/citations';

export interface SubagentEvent {
  id: string;
  agent: string;
  status: 'pending' | 'running' | 'complete';
  description?: string;
  content?: string;
}

export interface Source {
  type: 'academic' | 'web';
  title: string;
  authors?: string[];
  journal?: string;
  year?: number;
  doi?: string;
  abstract?: string;
  url?: string;
  source?: string;
  date?: string;
  snippet?: string;
  citationNumber: number;
}

interface Project {
  id: string;
  name: string;
  createdAt: string;
  versionCount: number;
}

interface VersionInfo {
  version: number;
  question: string;
  trigger: string;
  createdAt: string;
}

interface DiffData {
  v1: { version: number; report: string; createdAt: string; question: string };
  v2: { version: number; report: string; createdAt: string; question: string };
}

export default function Home() {
  const { t, locale } = useI18n();
  const [isResearching, setIsResearching] = useState(false);
  const [subagents, setSubagents] = useState<SubagentEvent[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [report, setReport] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState({ input: 0, output: 0 });
  const abortControllerRef = useRef<AbortController | null>(null);
  // Synchronous re-entry guard. The submit button is disabled via `isResearching`,
  // but a rapid double-click within the same render frame can fire twice before
  // React re-renders and disables it. This ref flips synchronously so the second
  // call bails immediately. Released in streamResearch's finally.
  const busyRef = useRef(false);

  // Project state
  const [projects, setProjects] = useState<Project[]>([]);
  // Tracks the very first load — distinct from a refetch — so the sidebar
  // can render skeleton rows on slow networks instead of a misleading
  // "no projects yet" empty state.
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [versionsLoading, setVersionsLoading] = useState(false);
  // Tracks the per-version load (the "get_version" request that pulls the
  // saved report body + sources). Distinct from `versionsLoading`, which
  // covers the project-level "list of versions" fetch. Used to overlay a
  // skeleton on the main content area while we swap projects so the user
  // gets immediate feedback on switch.
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  // Pending action that would interrupt an active research run (non-null = the
  // confirmation modal is open). Covers both "create new project" and "switch
  // to another project" — both must abort the in-flight AI request on confirm.
  const [pendingInterrupt, setPendingInterrupt] = useState<
    | { type: 'create'; name: string }
    | { type: 'switch'; projectId: string }
    | null
  >(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // Conversation identity is **per project**, not per page. The backend keys
  // its OpenAI Agents session (research history) by conversationId; a single
  // page-lifetime id would make every project share one session, so a new
  // project would inherit the previous project's research context and produce
  // identical/contaminated output. We therefore use the projectId itself as
  // the conversation key once a project is selected, and a stable fallback id
  // only for the brief standalone window before any project exists.
  const standaloneConvIdRef = useRef<string>(crypto.randomUUID());
  const conversationId = selectedProjectId ?? standaloneConvIdRef.current;
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);

  // Sidebar collapsed on mobile
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Blob storage availability warning
  const [blobWarning, setBlobWarning] = useState<string | null>(null);

  // Sub-question confirmation state
  const [pendingSubQuestions, setPendingSubQuestions] = useState<string[] | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [pendingDepth, setPendingDepth] = useState('standard');
  // Citation style chosen at the start of a research run, reused for follow-ups
  // and regenerations within the same session.
  const [citationStyle, setCitationStyle] = useState<string>('apa');

  // Diff state
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);

  // Tick counter to signal FollowUpChat when research/regeneration completes
  const [researchCompleteTick, setResearchCompleteTick] = useState(0);

  // Load projects on mount
  useEffect(() => { loadProjects(); }, []);

  // Auto-load latest version when project selected. Switch is synchronous
  // from the user's perspective: blank out the previous report immediately
  // and flip `loadingVersion` so the main panel shows a skeleton, then let
  // loadProjectVersions → loadVersion fill the new content in.
  useEffect(() => {
    if (selectedProjectId) {
      setReport('');
      setSources([]);
      setSubagents([]);
      setCurrentVersion(null);
      setLoadingVersion(true);
      loadProjectVersions(selectedProjectId);
    } else {
      setVersions([]);
      setCurrentVersion(null);
      setReport('');
      setSources([]);
      setSubagents([]);
      setLoadingVersion(false);
    }
  }, [selectedProjectId]);

  const loadProjects = async () => {
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      if (res.ok) {
        const { projects: p } = await res.json();
        setProjects(p || []);
        setBlobWarning(null);
      } else if (res.status === 503) {
        setBlobWarning('Blob 存储未配置，项目和聊天记录无法保存。请在 .env 中配置 PROJECT_ID 和 EDGEONE_PAGES_API_TOKEN，或部署到 EdgeOne Makers 平台。');
      }
    } catch {} finally {
      setProjectsLoading(false);
    }
  };

  const loadProjectVersions = async (projectId: string): Promise<number> => {
    setVersionsLoading(true);
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', id: projectId }),
      });
      if (res.ok) {
        const { versions: v } = await res.json();
        setVersions(v || []);
        // Auto-load latest version. If the project has no versions yet
        // (newly-created project), there's nothing to load — but we still
        // need to clear the loadingVersion flag the project-switch effect
        // set, otherwise the main panel stays in its skeleton state forever.
        if (v && v.length > 0) {
          loadVersion(projectId, v[v.length - 1].version);
        } else {
          setLoadingVersion(false);
        }
        return (v || []).length;
      }
    } catch {} finally {
      setVersionsLoading(false);
    }
    return 0;
  };

  const loadVersion = async (projectId: string, version: number) => {
    setLoadingVersion(true);
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_version', id: projectId, version }),
      });
      if (res.ok) {
        const { version: data } = await res.json();
        if (data) {
          setReport(data.report || '');
          setCurrentVersion(version);
          const allSources: Source[] = [];
          // Re-number citation markers from 1 across (papers, articles) in
          // exactly the order the backend tools produced them. Some legacy
          // saved versions wrote `citationNumber` per-array (papers 1..P AND
          // articles 1..N, instead of the registry's papers 1..P, articles
          // P+1..N), which collided into duplicate React keys + duplicate
          // SourceCard ids the moment the project was loaded. We can't trust
          // a stored citationNumber for backward compat — but the array
          // ordering is canonical, so we just ignore the stored field and
          // re-number sequentially. This matches the SSE-streaming path
          // (page.tsx streamResearch counter) and produces the same numbering
          // the model used when it wrote the report.
          let counter = 0;
          for (const p of data.papers || []) {
            counter++;
            allSources.push({ type: 'academic', ...p, citationNumber: counter, authors: normalizeAuthors(p.authors) });
          }
          for (const a of data.articles || []) {
            counter++;
            allSources.push({ type: 'web', ...a, citationNumber: counter, authors: normalizeAuthors(a.authors) });
          }
          setSources(allSources);
          // Hydrate the progress tree from saved version data. Pass the
          // sub-questions / papers / articles JSON-encoded into each stage's
          // content so ProgressTree (orchestration pipeline) can render its
          // input→output data summaries (matches the live SSE shape).
          const savedSubQuestions = Array.isArray(data.subQuestions) ? data.subQuestions : [];
          const savedPapers = Array.isArray(data.papers) ? data.papers : [];
          const savedArticles = Array.isArray(data.articles) ? data.articles : [];
          setSubagents([
            {
              id: 'stage-1',
              agent: 'question-decomposer',
              status: 'complete',
              ...(savedSubQuestions.length > 0 ? { content: JSON.stringify(savedSubQuestions) } : {}),
            },
            {
              id: 'stage-2',
              agent: 'literature-searcher',
              status: 'complete',
              ...(savedPapers.length > 0 ? { content: JSON.stringify(savedPapers) } : {}),
            },
            {
              id: 'stage-3',
              agent: 'web-researcher',
              status: 'complete',
              ...(savedArticles.length > 0 ? { content: JSON.stringify(savedArticles) } : {}),
            },
            { id: 'stage-4', agent: 'synthesizer', status: 'complete' },
          ]);
        }
      }
    } catch {} finally {
      setLoadingVersion(false);
    }
  };

  // Shared helper: creates a project, updates state, and returns the new project id.
  // Kept side-effect-pure w.r.t. research state — it is also called from the
  // auto-create path inside handleResearch, where isResearching must stay true.
  const createProject = async (name: string): Promise<string | null> => {
    setCreatingProject(true);
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name }),
      });
      if (res.ok) {
        const { project } = await res.json();
        setProjects(prev => [
          { id: project.id, name: project.name, createdAt: project.createdAt, versionCount: 0 },
          ...prev,
        ]);
        setReport('');
        setSources([]);
        setSubagents([]);
        setError(null);
        setVersions([]);
        setCurrentVersion(null);
        setDiffData(null);
        setTokenUsage({ input: 0, output: 0 });
        setSelectedProjectId(project.id);
        return project.id;
      }
    } catch {} finally {
      setCreatingProject(false);
    }
    return null;
  };

  const handleCreateProject = async (name: string) => {
    // If a research run is active, don't silently interrupt it — ask the user
    // to confirm first. The actual abort+create happens in confirmInterrupt.
    if (isResearching || busyRef.current) {
      setPendingInterrupt({ type: 'create', name });
      return;
    }
    await createProject(name);
  };

  // Project switch. While a research run is active, switching would leave the
  // in-flight SSE stream writing into the shared report/sources state — so the
  // newly-opened project would still show the old run's progress. Confirm first
  // and abort the AI request on switch.
  const handleSelectProject = (id: string) => {
    if (id === selectedProjectId) return;
    if (isResearching || busyRef.current) {
      setPendingInterrupt({ type: 'switch', projectId: id });
      return;
    }
    setSelectedProjectId(id);
  };

  // User confirmed interrupting the active research. Abort the AI request, then
  // perform the pending action (create a new project or switch to another).
  const confirmInterrupt = async () => {
    const action = pendingInterrupt;
    setPendingInterrupt(null);
    if (!action) return;
    // Abort the in-flight research so its SSE stream can't keep writing into
    // the shared state after we leave the current project.
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    busyRef.current = false;
    setIsResearching(false);
    if (action.type === 'create') {
      await createProject(action.name);
    } else {
      setSelectedProjectId(action.projectId);
    }
  };

  // User declined — keep the current research running, drop the pending action.
  const cancelInterrupt = () => {
    setPendingInterrupt(null);
  };

  const handleDeleteProject = async (id: string) => {
    try {
      await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (selectedProjectId === id) {
        setSelectedProjectId(null);
      }
      await loadProjects();
    } catch {}
  };

  const handleDiff = async (v1: number, v2: number) => {
    if (!selectedProjectId) return;
    setIsDiffLoading(true);
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'diff', id: selectedProjectId, v1, v2 }),
      });
      if (res.ok) {
        const data = await res.json();
        setDiffData(data);
      }
    } catch {} finally {
      setIsDiffLoading(false);
    }
  };

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
    busyRef.current = false;
    setIsResearching(false);
    // Notify backend to cancel the active run
    fetch("/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "makers-conversation-id": conversationId,
      },
      body: JSON.stringify({ conversationId }),
    }).catch(() => {});
  }, [conversationId]);

  // Main research handler — Phase 1: decompose only, wait for user confirmation
  const handleResearch = useCallback(async (question: string, depth: string, style: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsResearching(true);
    setSubagents([]);
    setSources([]);
    setReport('');
    setError(null);
    setTokenUsage({ input: 0, output: 0 });
    setPendingSubQuestions(null);
    setPendingQuestion(question);
    setPendingDepth(depth);
    setCitationStyle(style);

    // Auto-create a project named after the research question when none is selected
    let effectiveProjectId = selectedProjectId;
    if (!effectiveProjectId) {
      const truncatedName = question.length > 60 ? question.slice(0, 60) + '…' : question;
      effectiveProjectId = await createProject(truncatedName);
    }

    // Phase 1: decompose only
    await streamResearch({ message: question, depth, projectId: effectiveProjectId || undefined, decomposeOnly: true, locale, citationStyle: style });
  }, [selectedProjectId]);

  // Phase 2: user confirmed sub-questions, proceed with full research
  const handleConfirmSubQuestions = useCallback(async (confirmedQuestions: string[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPendingSubQuestions(null);
    setIsResearching(true);
    setSubagents([]);
    setSources([]);
    setReport('');
    setError(null);

    await streamResearch({
      message: pendingQuestion,
      depth: pendingDepth,
      projectId: selectedProjectId || undefined,
      confirmedSubQuestions: confirmedQuestions,
      locale,
      citationStyle,
    });
  }, [selectedProjectId, pendingQuestion, pendingDepth, citationStyle]);

  // Regenerate report (triggered from chat after user confirms)
  const handleRegenerate = useCallback(async (chatSummary: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsResearching(true);
    // Don't clear subagents/sources/report here. The backend follow-up path
    // replays the 4-stage lifecycle (with previous papers/articles attached)
    // before the editor stream starts, so the left panel updates in place.
    setError(null);
    setTokenUsage({ input: 0, output: 0 });

    await streamResearch({
      message: chatSummary,
      depth: 'standard',
      projectId: selectedProjectId || undefined,
      locale,
      citationStyle,
    });
    // Signal FollowUpChat that regeneration is complete (only fires for regeneration, not initial research)
    setResearchCompleteTick(c => c + 1);
  }, [selectedProjectId, citationStyle]);

  // Add a source to the left panel (triggered from chat suggest_add_source)
  const handleAddSource = useCallback((source: { title: string; url?: string; year?: number; authors?: string }) => {
    setSources(prev => {
      const nextCitationNumber = prev.length > 0 ? Math.max(...prev.map(s => s.citationNumber)) + 1 : 1;
      const newSource: Source = {
        type: 'academic',
        title: source.title,
        url: source.url,
        year: source.year,
        authors: source.authors ? [source.authors] : undefined,
        citationNumber: nextCitationNumber,
      };
      return [...prev, newSource];
    });
  }, []);

  // Append a fully-formed Source (used by SourcesPanel's manual-add /
  // DOI-enrich UI). The number is reassigned to be unique.
  const handleAppendSource = useCallback((source: Source) => {
    setSources(prev => {
      const nextCitationNumber = prev.length > 0 ? Math.max(...prev.map(s => s.citationNumber)) + 1 : 1;
      return [...prev, { ...source, citationNumber: nextCitationNumber }];
    });
  }, []);

  // Update an existing source by citationNumber (in-place edit from SourcesPanel)
  const handleUpdateSource = useCallback((updated: Source) => {
    setSources(prev => prev.map(s => s.citationNumber === updated.citationNumber ? updated : s));
  }, []);

  // Remove a source. Citation numbers of the remaining sources are NOT
  // renumbered — the existing report body already references them and
  // renumbering would break those links. The CitationCoverage panel will
  // surface any orphaned `[N]` left in the body.
  const handleDeleteSource = useCallback((citationNumber: number) => {
    setSources(prev => prev.filter(s => s.citationNumber !== citationNumber));
  }, []);

  // Triggered from a SourceCard's "Re-read & rewrite" action. Sends a
  // follow-up edit instruction tailored to that single source. The prompt
  // tells the model to integrate this source into a relevant section,
  // not to rewrite the whole report.
  const handleRewriteFromSource = useCallback((source: Source, instruction: string) => {
    // Authors might still be the wire-form string for very old saved versions;
    // normalize before reading [0].
    const authors = normalizeAuthors(source.authors);
    const sourceLabel = authors?.[0] && source.year
      ? `[${source.citationNumber}] ${authors[0]} et al. (${source.year}) — ${source.title}`
      : `[${source.citationNumber}] ${source.title}`;
    const fullInstruction = instruction
      ? `${instruction}\n\nFocus source: ${sourceLabel}${source.doi ? ` (DOI: ${source.doi})` : ''}${source.url ? ` (${source.url})` : ''}`
      : `Carefully re-read source ${sourceLabel} and integrate its key findings into the most relevant section of the report. Add inline citations to ${source.citationNumber} where appropriate. Preserve everything else.`;
    handleRegenerate(fullInstruction);
  }, [handleRegenerate]);

  // Core streaming logic
  const streamResearch = async (body: Record<string, unknown>) => {
    let citationCounter = 0;
    let lastReport = '';
    let lastSources: Source[] = [];

    abortControllerRef.current = new AbortController();

    // Use the run's projectId as the conversation key. During auto-create the
    // `selectedProjectId` state hasn't re-rendered into this closure yet, so we
    // read `body.projectId` directly — this keeps each project's research bound
    // to its own backend session and prevents cross-project contamination.
    const convId = (body.projectId as string) || conversationId;

    try {
      const response = await fetch('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'makers-conversation-id': convId },
        body: JSON.stringify(body),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        let errMsg = `Research failed: ${response.statusText}`;
        try {
          const errBody = await response.text();
          if (response.status === 429 || errBody.includes("quota")) {
            errMsg = t.quotaExhausted;
          } else if (errBody) {
            errMsg = errBody.slice(0, 200);
          }
        } catch {}
        throw new Error(errMsg);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let synthesizerContent = '';
      let currentAgent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;

          try {
            const event = JSON.parse(payload);

            switch (event.type) {
              case 'ping': break;

              case 'subagent_lifecycle':
                setSubagents(prev => {
                  const idx = prev.findIndex(s => s.id === event.id);
                  if (idx >= 0) {
                    const existing = prev[idx];
                    const nextContent = event.content || existing.content;
                    // Skip the state update entirely when nothing observable
                    // changed. Returning the same array short-circuits React's
                    // re-render and prevents fan-out to ProgressTree /
                    // SourcesPanel / ReportView on no-op SSE pings.
                    if (existing.status === event.status && existing.content === nextContent) {
                      return prev;
                    }
                    const nextArr = prev.slice();
                    nextArr[idx] = { ...existing, status: event.status, content: nextContent };
                    return nextArr;
                  }
                  return [...prev, { id: event.id, agent: event.agent, status: event.status, description: event.description, content: event.content }];
                });

                if (event.status === 'complete' && event.content) {
                  try {
                    const parsed = JSON.parse(event.content);
                    if (Array.isArray(parsed)) {
                      const newSources: Source[] = parsed
                        .filter((item: any) => item.title && item.title.trim())
                        .map((item: any) => {
                          citationCounter++;
                          // Always re-number sequentially across all SSE
                          // batches. The backend's _tools.ts numbers
                          // papers 1..P and articles P+1..N (offset by
                          // registry.papers.length), so a continuously
                          // running counter produces the SAME numbers the
                          // model was shown — but it also bullet-proofs
                          // against legacy/buggy payloads that double-emit
                          // [1..N] in both batches (which collided into
                          // duplicate React keys + source-N ids).
                          // Normalize authors — backend emits a comma-joined
                          // string for academic sources, but the frontend
                          // Source type expects string[]. UI code calling
                          // `.join()` would otherwise blow up.
                          const normalized = { ...item, authors: normalizeAuthors(item.authors) };
                          if (item.doi || item.journal) {
                            return { type: 'academic' as const, ...normalized, citationNumber: citationCounter };
                          }
                          return { type: 'web' as const, ...normalized, citationNumber: citationCounter };
                        });
                      lastSources = [...lastSources, ...newSources];
                      setSources(prev => [...prev, ...newSources]);
                    }
                  } catch {}
                }
                break;

              case 'source_switch':
                currentAgent = event.agent;
                break;

              case 'ai_response':
                const agent = event.agent || currentAgent;
                if (agent === 'synthesizer' || agent === 'main') {
                  if (!synthesizerContent) {
                    // First chunk of new report — replace old sources with new ones from this run
                    setSources(lastSources);
                  }
                  synthesizerContent += event.content;
                  lastReport = synthesizerContent;
                  setReport(synthesizerContent);
                }
                break;

              case 'error_message':
                const errContent = event.content || '';
                if (errContent.includes('429') || errContent.includes('quota')) {
                  setError(t.quotaExhausted);
                } else {
                  setError(errContent);
                }
                break;

              case 'usage':
                setTokenUsage({ input: event.input_tokens || 0, output: event.output_tokens || 0 });
                break;

              case 'decompose_complete':
                // Sub-questions generated — show for user confirmation
                if (Array.isArray(event.subQuestions) && event.subQuestions.length > 0) {
                  setPendingSubQuestions(event.subQuestions);
                }
                break;

              case 'report_replace':
                // Structure check cleaned the report — replace displayed content
                if (event.content) {
                  synthesizerContent = event.content;
                  lastReport = event.content;
                  setReport(event.content);
                }
                break;
            }
          } catch {}
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message);
        setSubagents([]);
      }
    } finally {
      busyRef.current = false;
      setIsResearching(false);
      abortControllerRef.current = null;
      // Use body.projectId first to handle the auto-create case where selectedProjectId
      // may still be null in this closure (React state update hasn't re-rendered yet)
      const effectiveProjectId = (body.projectId as string) || selectedProjectId;
      if (effectiveProjectId && lastReport) {
        // Wait briefly for backend store write propagation (research.ts saves directly via context.store)
        await new Promise(r => setTimeout(r, 800));
        const prevCount = versions.length;
        const newCount = await loadProjectVersions(effectiveProjectId);

        if (newCount <= prevCount) {
          // Backend save didn't run (local dev / context.store unavailable) — frontend fallback
          try {
            const papers = lastSources.filter(s => s.type === 'academic');
            const articles = lastSources.filter(s => s.type === 'web');
            await fetch('/project', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'save_version',
                id: effectiveProjectId,
                versionData: {
                  question: body.message || '',
                  depth: body.depth || 'standard',
                  papers,
                  articles,
                  scrapedUrls: [],
                  report: lastReport,
                  trigger: prevCount > 0 ? 'follow-up' : 'initial',
                },
              }),
            });
          } catch {}
          // Wait for blob write then reload
          await new Promise(r => setTimeout(r, 500));
          await loadProjectVersions(effectiveProjectId);
        }

        await loadProjects();
      }
    }
  };

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  return (
    <div className="min-h-screen flex">
      {/* Left Sidebar — Project List */}
      <aside className={`${sidebarOpen ? 'w-64' : 'w-0'} flex-shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 transition-all overflow-hidden fixed top-0 left-0 h-screen z-20`}>
        <div className="w-64 h-full flex flex-col p-4">
          <ProjectSelector
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelect={handleSelectProject}
            onCreate={handleCreateProject}
            onDelete={handleDeleteProject}
            loading={projectsLoading}
            creating={creatingProject}
          />
        </div>
      </aside>
      {/* Spacer for fixed sidebar */}
      {sidebarOpen && <div className="w-64 flex-shrink-0" />}

      {/* Main Content */}
      <main className="flex-1 min-h-screen overflow-y-auto">
        {/* Header */}
        <header className="border-b border-neutral-200 dark:border-neutral-800 bg-white/50 dark:bg-neutral-900/50 backdrop-blur-sm sticky top-0 z-10">
          <div className="px-6 py-4 flex items-center gap-3">
            {/* Sidebar toggle */}
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1.5 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <h1 className="font-serif text-xl font-bold text-neutral-900 dark:text-warm-100">
              {t.title}
            </h1>

            {/* Current project name */}
            {selectedProject && (
              <span className="text-sm text-neutral-600 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 px-3 py-1 rounded-full truncate max-w-48">
                {selectedProject.name}
              </span>
            )}

            <div className="ml-auto flex items-center gap-3">
              <DeployButtons
                templateSlug="deep-research-agent"
                githubUrl="https://github.com/edgeone-pages-test/deep-research-agent"
                lang={locale}
              />
              <TokenUsage inputTokens={tokenUsage.input} outputTokens={tokenUsage.output} />
              <LanguageToggle />
            </div>
          </div>
        </header>

        <div className="max-w-6xl mx-auto px-6 py-8">
          {/* Blob storage warning */}
          {blobWarning && (
            <div className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.27 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span>{blobWarning}</span>
              <button onClick={() => setBlobWarning(null)} className="ml-auto p-0.5 hover:bg-amber-200 dark:hover:bg-amber-800 rounded">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Research Form — hidden once a report is generated or research is running */}
          {!report && !pendingSubQuestions && !isResearching && (!selectedProjectId || versions.length === 0) && (
            <>
              {selectedProjectId && versions.length === 0 && (
                <div className="mb-6 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-sm flex items-center gap-3">
                  <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span dangerouslySetInnerHTML={{ __html: t.projectCreated.replace('{name}', `<strong>${selectedProject?.name ?? ''}</strong>`) }} />
                </div>
              )}
              <ResearchForm key={selectedProjectId || '__none__'} onSubmit={handleResearch} isLoading={isResearching} />
            </>
          )}

          {/* Stop Button — shown whenever research is running */}
          {isResearching && !pendingSubQuestions && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={handleStop}
                className="px-6 py-2.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors flex items-center gap-2"
              >
                <span className="inline-block w-3 h-3 bg-white rounded-sm" />
                {t.stopResearch}
              </button>
            </div>
          )}

          {/* Sub-question Confirmation UI */}
          {pendingSubQuestions && (
            <SubQuestionConfirm
              questions={pendingSubQuestions}
              onConfirm={handleConfirmSubQuestions}
              onCancel={() => { setPendingSubQuestions(null); setPendingQuestion(''); setPendingDepth('standard'); }}
            />
          )}

          {/* Error Display */}
          {error && (
            <div className="mt-6 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Version Selector — show a slim placeholder while versions
              are loading so the user gets immediate feedback (especially
              important on slow networks where the project's /get request
              can take a few hundred ms). Hide entirely once we know the
              project has zero versions. */}
          {selectedProjectId && (versionsLoading || versions.length > 0) && (
            <div className="mt-6">
              {versionsLoading && versions.length === 0 ? (
                <div className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/60">
                  <svg className="w-3.5 h-3.5 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">{t.versions}…</span>
                </div>
              ) : (
                <VersionSelector
                  versions={versions}
                  currentVersion={currentVersion}
                  onSelectVersion={(v) => loadVersion(selectedProjectId, v)}
                  onDiff={handleDiff}
                />
              )}
            </div>
          )}

          {/* Diff View */}
          {isDiffLoading && !diffData && (
            <div className="mt-6 p-6 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex items-center justify-center gap-3 text-sm text-neutral-600 dark:text-neutral-400">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t.comparingVersions}
            </div>
          )}
          {diffData && (
            <DiffView v1={diffData.v1} v2={diffData.v2} onClose={() => setDiffData(null)} />
          )}

          {/* Results Area — hide when there's an error and no report */}
          {/* Skeleton during project switch — shown while loadingVersion is
              true and we haven't received any subagents/report yet. Mirrors
              the real layout (left sidebar + right report) so the swap
              feels seamless instead of a sudden flash. */}
          {loadingVersion && subagents.length === 0 && !report && !error && (
            <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
              <aside className="lg:col-span-4 space-y-4">
                <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-3">
                  <div className="h-4 w-24 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                  <div className="space-y-2 mt-3">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className="h-3 w-3 rounded-full bg-neutral-200 dark:bg-neutral-800 animate-pulse flex-shrink-0" />
                        <div className="h-3 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" style={{ width: `${70 - i * 8}%` }} />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-2">
                  <div className="h-4 w-20 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="border border-neutral-100 dark:border-neutral-800 rounded-lg p-3 space-y-2">
                      <div className="h-3 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" style={{ width: '85%' }} />
                      <div className="h-2.5 rounded bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" style={{ width: '60%' }} />
                    </div>
                  ))}
                </div>
              </aside>
              <div className="lg:col-span-8">
                <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 space-y-3">
                  <div className="h-6 w-1/2 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                  <div className="h-3 w-full rounded bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" />
                  <div className="h-3 w-11/12 rounded bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" />
                  <div className="h-3 w-10/12 rounded bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" />
                  <div className="h-5 w-1/3 mt-4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                  <div className="h-3 w-full rounded bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" />
                  <div className="h-3 w-9/12 rounded bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" />
                  <div className="h-3 w-11/12 rounded bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse" />
                </div>
              </div>
            </div>
          )}

          {(subagents.length > 0 || report) && !error && (
            <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left side: combined progress / sources / coverage in a sticky
                  scroll panel so the right report column gets full height.
                  Width is tighter (4/12) than before to give the report
                  more breathing room. */}
              <aside className="lg:col-span-4 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto space-y-4">
                <ProgressTree subagents={subagents} isActive={isResearching} />
                <SourcesPanel
                  sources={sources}
                  onAddSource={handleAppendSource}
                  onUpdateSource={handleUpdateSource}
                  onDeleteSource={handleDeleteSource}
                  onRewriteFromSource={handleRewriteFromSource}
                  disabled={isResearching}
                />
                {/* Citation coverage — research-template differentiator.
                    Only render once a non-streaming report is in hand;
                    coverage during streaming would jitter as text flows in. */}
                {report && !isResearching && sources.length > 0 && (
                  <CitationCoverage report={report} sources={sources} />
                )}
              </aside>
              <div className="lg:col-span-8">
                <ReportView content={report} isStreaming={isResearching} sources={sources} citationStyle={citationStyle} />
              </div>
            </div>
          )}

          {/* Follow-up Chat — shown after research completes */}
          {(report && !isResearching) && (
            <div className="mt-8">
              <FollowUpChat
                key={`chat-${selectedProjectId || 'none'}`}
                onRegenerate={handleRegenerate}
                onAddSource={handleAddSource}
                isRegenerating={isResearching}
                projectId={selectedProjectId || ''}
                report={report}
                conversationId={conversationId}
                completionTick={researchCompleteTick}
              />
            </div>
          )}
        </div>
      </main>

      {/* Interrupt-research confirmation modal (covers new-project & switch) */}
      {pendingInterrupt !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={cancelInterrupt}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {t.interruptResearchTitle}
                </h3>
                <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                  {t.interruptResearchMessage}
                </p>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                onClick={cancelInterrupt}
                className="px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-sm font-medium text-neutral-600 dark:text-neutral-400 transition-colors"
              >
                {t.cancel}
              </button>
              <button
                onClick={confirmInterrupt}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium transition-colors"
              >
                {t.interruptResearchConfirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
