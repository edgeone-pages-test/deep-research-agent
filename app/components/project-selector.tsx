'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';

interface Project {
  id: string;
  name: string;
  createdAt: string;
}

interface ProjectSelectorProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
}

export function ProjectSelector({
  projects,
  selectedProjectId,
  onSelect,
  onCreate,
  onDelete,
}: ProjectSelectorProps) {
  const { t } = useI18n();
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreate(newName.trim());
    setNewName('');
    setIsCreating(false);
  };

  const handleDelete = (id: string) => {
    onDelete(id);
    setDeleteConfirmId(null);
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  if (projects.length === 0 && !isCreating) {
    return (
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 text-center space-y-4">
        <div className="text-neutral-500 dark:text-neutral-400 text-sm">
          还没有研究项目，创建一个开始吧
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 shadow-sm transition-all"
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新建项目
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-3">
      {/* Project list */}
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {projects.map((project) => (
          <div
            key={project.id}
            className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors group ${
              selectedProjectId === project.id
                ? 'bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600'
                : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50 border border-transparent'
            }`}
            onClick={() => onSelect(project.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
                {project.name}
              </div>
              <div className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">
                {formatDate(project.createdAt)}
              </div>
            </div>

            {/* Delete button */}
            {deleteConfirmId === project.id ? (
              <div className="flex items-center gap-1 ml-2" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => handleDelete(project.id)}
                  className="text-xs px-2 py-1 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                >
                  确认
                </button>
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="text-xs px-2 py-1 rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirmId(project.id);
                }}
                className="opacity-0 group-hover:opacity-100 ml-2 p-1 rounded text-neutral-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
                aria-label="Delete project"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Create new project */}
      {isCreating ? (
        <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 space-y-2.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="输入项目名称..."
            className="w-full bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 dark:focus:ring-blue-400/40 dark:focus:border-blue-400 dark:text-neutral-100 placeholder:text-neutral-400 transition-all"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => { setIsCreating(false); setNewName(''); }}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="px-4 py-1.5 rounded-md text-xs font-medium text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-all"
            >
              创建项目
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsCreating(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300 border border-dashed border-neutral-300 dark:border-neutral-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新建项目
        </button>
      )}
    </div>
  );
}
