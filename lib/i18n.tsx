'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

type Locale = 'zh' | 'en';

export const translations = {
  zh: {
    title: '深度研究',
    description: '多智能体驱动的深度研究助手',
    inputPlaceholder: '输入研究问题',
    startResearch: '开始研究',
    quick: '快速',
    standard: '标准',
    deep: '深度',
    academicSources: '学术来源',
    webSources: '网页来源',
    researchReport: '研究报告',
    multiAgent: '多智能体',
    progress: '研究进度',
    sources: '来源',
    researching: '研究中...',
    tryExample: '试试示例',
    initializingPipeline: '初始化研究管道...',
    noAcademicSources: '暂无学术来源...',
    noWebSources: '暂无网页来源...',
    academic: '学术',
    web: '网页',
    generatingReport: '生成报告中...',
    copy: '复制',
    download: '下载',
    history: '历史',
    // Project management
    projects: '研究项目',
    newProject: '新建项目',
    projectName: '项目名称',
    createProject: '创建',
    deleteProject: '删除项目',
    confirmDelete: '确认删除？',
    noProjects: '还没有研究项目，创建一个开始吧',
    selectProject: '选择项目',
    // Versions
    version: '版本',
    versions: '版本历史',
    currentVersion: '当前版本',
    compareVersions: '对比版本',
    versionOf: '第 {n} 版',
    // Follow-up
    followUpPlaceholder: '继续研究：追问、深入某个方向、或粘贴URL添加语料...',
    continueResearch: '继续研究',
    urlDetected: '检测到URL，将自动抓取内容',
    // Diff
    diffTitle: '版本对比',
    added: '新增',
    removed: '删除',
    close: '关闭',
  },
  en: {
    title: 'Deep Research',
    description: 'Multi-agent powered deep research assistant',
    inputPlaceholder: 'Enter research question',
    startResearch: 'Start Research',
    quick: 'Quick',
    standard: 'Standard',
    deep: 'Deep',
    academicSources: 'Academic Sources',
    webSources: 'Web Sources',
    researchReport: 'Research Report',
    multiAgent: 'Multi-Agent',
    progress: 'Progress',
    sources: 'Sources',
    researching: 'Researching...',
    tryExample: 'Try an example',
    initializingPipeline: 'Initializing research pipeline...',
    noAcademicSources: 'No academic sources yet...',
    noWebSources: 'No web sources yet...',
    academic: 'Academic',
    web: 'Web',
    generatingReport: 'Generating report...',
    copy: 'Copy',
    download: 'Download',
    history: 'History',
    // Project management
    projects: 'Projects',
    newProject: 'New Project',
    projectName: 'Project name',
    createProject: 'Create',
    deleteProject: 'Delete project',
    confirmDelete: 'Confirm delete?',
    noProjects: 'No research projects yet. Create one to get started.',
    selectProject: 'Select project',
    // Versions
    version: 'Version',
    versions: 'Version History',
    currentVersion: 'Current',
    compareVersions: 'Compare',
    versionOf: 'v{n}',
    // Follow-up
    followUpPlaceholder: 'Continue research: ask follow-up questions, explore a direction, or paste URLs...',
    continueResearch: 'Continue',
    urlDetected: 'URL detected — content will be scraped',
    // Diff
    diffTitle: 'Version Comparison',
    added: 'Added',
    removed: 'Removed',
    close: 'Close',
  },
};

interface I18nContextType {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: typeof translations.zh;
}

const I18nContext = createContext<I18nContextType>({
  locale: 'zh',
  setLocale: () => {},
  t: translations.zh,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('zh');
  const t = translations[locale];
  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
