'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ResearchForm } from './components/research-form';
import { ProgressTree } from './components/progress-tree';
import { SourcesPanel } from './components/sources-panel';
import { ReportView } from './components/report-view';
import { ProjectSelector } from './components/project-selector';
import { FollowUpChat } from './components/follow-up-chat';
import { VersionSelector } from './components/version-selector';
import { DiffView } from './components/diff-view';
import { SubQuestionConfirm } from './components/sub-question-confirm';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { TokenUsage } from '@/components/ui/token-usage';
import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
  const [isResearching, setIsResearching] = useState(false);
  const [subagents, setSubagents] = useState<SubagentEvent[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [report, setReport] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState({ input: 0, output: 0 });
  const abortControllerRef = useRef<AbortController | null>(null);
  const conversationId = useMemo(() => crypto.randomUUID(), []);

  // Project state
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
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

  // Diff state
  const [diffData, setDiffData] = useState<DiffData | null>(null);

  // Load projects on mount
  useEffect(() => { loadProjects(); }, []);

  // Auto-load latest version when project selected
  useEffect(() => {
    if (selectedProjectId) {
      loadProjectVersions(selectedProjectId);
    } else {
      setVersions([]);
      setCurrentVersion(null);
      setReport('');
      setSources([]);
      setSubagents([]);
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
    } catch {}
  };

  const loadProjectVersions = async (projectId: string): Promise<number> => {
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', id: projectId }),
      });
      if (res.ok) {
        const { versions: v } = await res.json();
        setVersions(v || []);
        // Auto-load latest version
        if (v && v.length > 0) {
          loadVersion(projectId, v[v.length - 1].version);
        }
        return (v || []).length;
      }
    } catch {}
    return 0;
  };

  const loadVersion = async (projectId: string, version: number) => {
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
          let counter = 0;
          for (const p of data.papers || []) { counter++; allSources.push({ type: 'academic', citationNumber: counter, ...p }); }
          for (const a of data.articles || []) { counter++; allSources.push({ type: 'web', citationNumber: counter, ...a }); }
          setSources(allSources);
          setSubagents([
            { id: 'stage-1', agent: 'question-decomposer', status: 'complete' },
            { id: 'stage-2', agent: 'literature-searcher', status: 'complete' },
            { id: 'stage-3', agent: 'web-researcher', status: 'complete' },
            { id: 'stage-4', agent: 'synthesizer', status: 'complete' },
          ]);
        }
      }
    } catch {}
  };

  const handleCreateProject = async (name: string) => {
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name }),
      });
      if (res.ok) {
        const { project } = await res.json();
        // Optimistic update: immediately add to local state
        setProjects(prev => [
          { id: project.id, name: project.name, createdAt: project.createdAt, versionCount: 0 },
          ...prev,
        ]);
        // Clear old project state before selecting the new one
        setReport('');
        setSources([]);
        setSubagents([]);
        setError(null);
        setVersions([]);
        setCurrentVersion(null);
        setDiffData(null);
        setTokenUsage({ input: 0, output: 0 });
        setSelectedProjectId(project.id);
      }
    } catch {}
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
    } catch {}
  };

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsResearching(false);
    // Notify backend to cancel the active run
    fetch("/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "pages-agent-conversation-id": conversationId,
      },
      body: JSON.stringify({ conversationId }),
    }).catch(() => {});
  }, [conversationId]);

  // Main research handler — Phase 1: decompose only, wait for user confirmation
  const handleResearch = useCallback(async (question: string, depth: string) => {
    setIsResearching(true);
    setSubagents([]);
    setSources([]);
    setReport('');
    setError(null);
    setTokenUsage({ input: 0, output: 0 });
    setPendingSubQuestions(null);
    setPendingQuestion(question);
    setPendingDepth(depth);

    // Phase 1: decompose only
    await streamResearch({ message: question, depth, projectId: selectedProjectId || undefined, decomposeOnly: true });
  }, [selectedProjectId]);

  // Phase 2: user confirmed sub-questions, proceed with full research
  const handleConfirmSubQuestions = useCallback(async (confirmedQuestions: string[]) => {
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
    });
  }, [selectedProjectId, pendingQuestion, pendingDepth]);

  // Regenerate report (triggered from chat after user confirms)
  const handleRegenerate = useCallback(async (chatSummary: string) => {
    setIsResearching(true);
    setSubagents([]);
    // Keep old report and sources visible until new content starts streaming
    setError(null);
    setTokenUsage({ input: 0, output: 0 });

    await streamResearch({
      message: chatSummary,
      depth: 'standard',
      projectId: selectedProjectId || undefined,
    });
  }, [selectedProjectId]);

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

  // Core streaming logic
  const streamResearch = async (body: Record<string, unknown>) => {
    let citationCounter = 0;
    let lastReport = '';
    let lastSources: Source[] = [];

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'pages-agent-conversation-id': conversationId },
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
                  const existing = prev.find(s => s.id === event.id);
                  if (existing) {
                    return prev.map(s => s.id === event.id ? { ...s, status: event.status, content: event.content || s.content } : s);
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
                          if (item.doi || item.journal) {
                            return { type: 'academic' as const, citationNumber: citationCounter, ...item };
                          }
                          return { type: 'web' as const, citationNumber: citationCounter, ...item };
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
      setIsResearching(false);
      abortControllerRef.current = null;
      if (selectedProjectId && lastReport) {
        // Save version directly from frontend (more reliable than backend internal invoke)
        try {
          const papers = lastSources.filter(s => s.type === 'academic');
          const articles = lastSources.filter(s => s.type === 'web');
          await fetch('/project', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'save_version',
              id: selectedProjectId,
              versionData: {
                question: body.message || '',
                depth: body.depth || 'standard',
                papers,
                articles,
                report: lastReport,
                trigger: versions.length > 0 ? 'follow-up' : 'initial',
              },
            }),
          });
        } catch {}
        // Reload versions after save; retry once if count hasn't increased
        const prevCount = versions.length;
        const newCount = await loadProjectVersions(selectedProjectId);
        if (newCount <= prevCount) {
          await new Promise(r => setTimeout(r, 2000));
          await loadProjectVersions(selectedProjectId);
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
            onSelect={setSelectedProjectId}
            onCreate={handleCreateProject}
            onDelete={handleDeleteProject}
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
                  <span>项目 <strong>{selectedProject?.name}</strong> 已创建成功！在下方输入研究问题，开始第一次深度研究。</span>
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

          {/* Version Selector */}
          {selectedProjectId && versions.length > 0 && (
            <div className="mt-6">
              <VersionSelector
                versions={versions}
                currentVersion={currentVersion}
                onSelectVersion={(v) => loadVersion(selectedProjectId, v)}
                onDiff={handleDiff}
              />
            </div>
          )}

          {/* Diff View */}
          {diffData && (
            <DiffView v1={diffData.v1} v2={diffData.v2} onClose={() => setDiffData(null)} />
          )}

          {/* Results Area — hide when there's an error and no report */}
          {(subagents.length > 0 || report) && !error && (
            <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1 space-y-6">
                <ProgressTree subagents={subagents} isActive={isResearching} />
                <SourcesPanel sources={sources} />
              </div>
              <div className="lg:col-span-2">
                <ReportView content={report} isStreaming={isResearching} />
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
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
