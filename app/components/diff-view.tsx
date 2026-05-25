'use client';

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';

interface VersionData {
  version: number;
  report: string;
  createdAt: string;
  question: string;
}

interface DiffViewProps {
  v1: VersionData;
  v2: VersionData;
  onClose?: () => void;
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
}

function computeDiff(oldText: string, newText: string): { left: DiffLine[]; right: DiffLine[] } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const left: DiffLine[] = [];
  const right: DiffLine[] = [];

  // Simple LCS-based line diff
  const lcs = buildLCS(oldLines, newLines);
  let oi = 0;
  let ni = 0;
  let li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      left.push({ type: 'unchanged', content: oldLines[oi] });
      right.push({ type: 'unchanged', content: newLines[ni] });
      oi++;
      ni++;
      li++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      left.push({ type: 'removed', content: oldLines[oi] });
      right.push({ type: 'unchanged', content: '' });
      oi++;
    } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
      left.push({ type: 'unchanged', content: '' });
      right.push({ type: 'added', content: newLines[ni] });
      ni++;
    }
  }

  return { left, right };
}

function buildLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function DiffView({ v1, v2, onClose }: DiffViewProps) {
  const { left, right } = useMemo(() => computeDiff(v1.report, v2.report), [v1.report, v2.report]);

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            v{v1.version} vs v{v2.version}
          </h3>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {formatDate(v1.createdAt)} → {formatDate(v2.createdAt)}
          </span>
        </div>
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close diff view">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        )}
      </div>

      {/* Diff body - split view */}
      <div className="grid grid-cols-2 divide-x divide-neutral-200 dark:divide-neutral-800 max-h-[600px] overflow-y-auto">
        {/* Left (v1) */}
        <div className="min-w-0">
          <div className="px-3 py-2 border-b border-neutral-100 dark:border-neutral-800 bg-red-50/50 dark:bg-red-900/10">
            <span className="text-xs font-medium text-red-700 dark:text-red-400">
              v{v1.version}: {v1.question}
            </span>
          </div>
          <div className="font-mono text-xs leading-relaxed">
            {left.map((line, i) => (
              <div
                key={i}
                className={`px-3 py-0.5 whitespace-pre-wrap break-all ${
                  line.type === 'removed'
                    ? 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-300'
                    : 'text-neutral-700 dark:text-neutral-300'
                }`}
              >
                {line.type === 'removed' && <span className="select-none text-red-400 mr-2">-</span>}
                {line.content}
              </div>
            ))}
          </div>
        </div>

        {/* Right (v2) */}
        <div className="min-w-0">
          <div className="px-3 py-2 border-b border-neutral-100 dark:border-neutral-800 bg-green-50/50 dark:bg-green-900/10">
            <span className="text-xs font-medium text-green-700 dark:text-green-400">
              v{v2.version}: {v2.question}
            </span>
          </div>
          <div className="font-mono text-xs leading-relaxed">
            {right.map((line, i) => (
              <div
                key={i}
                className={`px-3 py-0.5 whitespace-pre-wrap break-all ${
                  line.type === 'added'
                    ? 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                    : 'text-neutral-700 dark:text-neutral-300'
                }`}
              >
                {line.type === 'added' && <span className="select-none text-green-400 mr-2">+</span>}
                {line.content}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
