'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface Version {
  version: number;
  question: string;
  trigger?: string;
  createdAt: string;
}

interface VersionSelectorProps {
  versions: Version[];
  currentVersion: number | null;
  onSelectVersion: (version: number) => void;
  onDiff: (v1: number, v2: number) => void;
}

export function VersionSelector({
  versions,
  currentVersion,
  onSelectVersion,
  onDiff,
}: VersionSelectorProps) {
  const [compareMode, setCompareMode] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const handleVersionClick = (version: number) => {
    if (compareMode) {
      setSelected((prev) => {
        if (prev.includes(version)) return prev.filter((v) => v !== version);
        if (prev.length >= 2) return [prev[1], version];
        return [...prev, version];
      });
    } else {
      onSelectVersion(version);
    }
  };

  const handleCompare = () => {
    if (selected.length === 2) {
      const sorted = [...selected].sort((a, b) => a - b);
      onDiff(sorted[0], sorted[1]);
      setCompareMode(false);
      setSelected([]);
    }
  };

  if (versions.length === 0) return null;

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          版本历史
        </h3>
        <div className="flex items-center gap-2">
          {compareMode && selected.length === 2 && (
            <Button size="sm" onClick={handleCompare}>
              对比
            </Button>
          )}
          <Button
            size="sm"
            variant={compareMode ? 'default' : 'outline'}
            onClick={() => {
              setCompareMode(!compareMode);
              setSelected([]);
            }}
          >
            {compareMode ? '取消对比' : '对比版本'}
          </Button>
        </div>
      </div>

      {/* Version list - horizontal scrollable */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {versions.map((ver) => {
          const isSelected = compareMode && selected.includes(ver.version);
          const isCurrent = ver.version === currentVersion;

          return (
            <button
              key={ver.version}
              onClick={() => handleVersionClick(ver.version)}
              className={`flex-shrink-0 px-3 py-2 rounded-lg border text-left transition-colors ${
                isSelected
                  ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : isCurrent
                  ? 'border-neutral-400 dark:border-neutral-500 bg-neutral-100 dark:bg-neutral-800'
                  : 'border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-sm font-medium ${
                  isCurrent ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-600 dark:text-neutral-400'
                }`}>
                  v{ver.version}
                </span>
                {isCurrent && !compareMode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300">
                    当前
                  </span>
                )}
                {isSelected && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-200">
                    {selected.indexOf(ver.version) + 1}
                  </span>
                )}
              </div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-[120px] truncate">
                {ver.question}
              </div>
              <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                {formatDate(ver.createdAt)}
              </div>
            </button>
          );
        })}
      </div>

      {/* Compare mode hint */}
      {compareMode && selected.length < 2 && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          选择两个版本进行对比 ({selected.length}/2)
        </p>
      )}
    </div>
  );
}
