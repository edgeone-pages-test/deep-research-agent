'use client';

import { useState } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';
import type { SubagentEvent } from '../page';

const AGENT_ICONS: Record<string, string> = {
  'question-decomposer': 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  'literature-searcher': 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  'web-researcher': 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
  'synthesizer': 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
};

interface ProgressTreeProps {
  subagents: SubagentEvent[];
  isActive: boolean;
}

export function ProgressTree({ subagents, isActive }: ProgressTreeProps) {
  const { t } = useI18n();

  const AGENT_LABELS: Record<string, string> = {
    'question-decomposer': t.decomposingQuestion,
    'literature-searcher': t.searchingLiterature,
    'web-researcher': t.searchingWeb,
    'synthesizer': t.synthesizingReport,
  };

  if (subagents.length === 0 && !isActive) return null;

  // Calculate progress percentage
  const totalStages = 4; // decomposer, literature, web, synthesizer
  const completedStages = subagents.filter(s => s.status === 'complete').length;
  const runningStages = subagents.filter(s => s.status === 'running').length;
  const progress = Math.round(((completedStages + runningStages * 0.5) / totalStages) * 100);

  return (
    <Card>
      <CardHeader>
        <h3 className="font-serif text-sm font-semibold text-neutral-900 dark:text-warm-100 flex items-center gap-2">
          <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          {t.progress}
          {isActive && (
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse-dot" />
          )}
          {isActive && subagents.length > 0 && (
            <span className="ml-auto text-xs font-normal text-neutral-500 dark:text-neutral-400">
              {progress}%
            </span>
          )}
        </h3>
        {isActive && subagents.length > 0 && (
          <div className="mt-2 w-full h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="relative space-y-0">
          {subagents.map((sub, index) => (
            <div key={sub.id} className="relative pl-8 pb-4 last:pb-0">
              {/* Connecting line */}
              {index < subagents.length - 1 && (
                <div className="absolute left-[15px] top-7 bottom-0 w-px bg-neutral-200 dark:bg-neutral-700" />
              )}

              {/* Status indicator */}
              <div className="absolute left-2 top-1.5">
                {sub.status === 'complete' ? (
                  <div className="w-5 h-5 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <svg className="w-3 h-3 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : sub.status === 'running' ? (
                  <div className="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <svg className="w-3 h-3 text-blue-600 dark:text-blue-400 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  </div>
                ) : (
                  <div className="w-5 h-5 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-neutral-400 dark:bg-neutral-500 animate-pulse-dot" />
                  </div>
                )}
              </div>

              {/* Content */}
              <div>
                <div className="flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={AGENT_ICONS[sub.agent] || 'M13 10V3L4 14h7v7l9-11h-7z'} />
                  </svg>
                  <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                    {AGENT_LABELS[sub.agent] || sub.agent}
                  </span>
                </div>
                {sub.description && (
                  <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
                    {sub.description}
                  </p>
                )}
                {/* Show sub-questions when question-decomposer completes */}
                {sub.agent === 'question-decomposer' && sub.status === 'complete' && sub.content && (() => {
                  try {
                    const questions = JSON.parse(sub.content);
                    if (Array.isArray(questions) && questions.length > 0) {
                      return <SubQuestionList questions={questions} />;
                    }
                  } catch {}
                  return null;
                })()}
              </div>
            </div>
          ))}

          {isActive && subagents.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t.initializingPipeline}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Collapsible sub-question list to avoid taking too much space
function SubQuestionList({ questions }: { questions: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {t.subQuestionCount.replace('{n}', String(questions.length))}
      </button>
      {expanded && (
        <ul className="mt-1.5 ml-1 space-y-1 border-l-2 border-neutral-200 dark:border-neutral-700 pl-2.5 max-h-48 overflow-y-auto">
          {questions.map((q: string, i: number) => (
            <li key={i} className="text-[11px] text-neutral-600 dark:text-neutral-400 flex items-start gap-1">
              <span className="text-neutral-400 dark:text-neutral-500 font-mono flex-shrink-0 text-[10px] mt-px">{i + 1}.</span>
              <span className="leading-snug line-clamp-2">{q}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
