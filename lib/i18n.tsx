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
    copied: '已复制！',
    download: '下载',
    history: '历史',
    stopResearch: '停止研究',
    // Agent stage labels
    decomposingQuestion: '分解问题',
    searchingLiterature: '搜索学术文献',
    searchingWeb: '搜索网络',
    synthesizingReport: '生成报告',
    subQuestionCount: '{n} 个子问题',
    // Example prompts
    examplePrompts: [
      '量子计算的最新进展及其实际应用是什么？',
      'AI 如何改变药物发现和蛋白质结构预测？',
      '训练大型语言模型对环境有哪些影响？',
      '比较不同 AI 对齐方法的有效性',
      '核聚变能源研究的现状如何？',
    ] as string[],
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
    continueResearchSubtitle: '追问、补充信息、或要求修改报告',
    chatInputPlaceholder: '追问报告内容、粘贴URL补充信息、或要求修改报告...',
    regenerateReport: '重新生成报告',
    suggestedSources: '是否添加以下文献到论文列表？',
    addSourceBtn: '添加',
    ignoreBtn: '忽略',
    regeneratingReport: '正在重新生成报告...',
    urlDetected: '检测到URL，将自动抓取内容',
    // Diff
    diffTitle: '版本对比',
    added: '新增',
    removed: '删除',
    close: '关闭',
    quotaExhausted: 'AI 模型调用额度已用尽，请稍后再试或升级套餐。',
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
    copied: 'Copied!',
    download: 'Download',
    history: 'History',
    stopResearch: 'Stop Research',
    // Agent stage labels
    decomposingQuestion: 'Decomposing Question',
    searchingLiterature: 'Searching Literature',
    searchingWeb: 'Searching Web',
    synthesizingReport: 'Synthesizing Report',
    subQuestionCount: '{n} sub-questions',
    // Example prompts
    examplePrompts: [
      'What are the latest advances in quantum computing and their practical applications?',
      'How is AI transforming drug discovery and protein structure prediction?',
      'What are the environmental impacts of large language model training?',
      'Compare the effectiveness of different approaches to AI alignment',
      'What is the current state of nuclear fusion energy research?',
    ] as string[],
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
    continueResearchSubtitle: 'Ask follow-ups, add context, or request report changes',
    chatInputPlaceholder: 'Ask follow-up questions, paste URLs, or request report changes...',
    regenerateReport: 'Regenerate Report',
    suggestedSources: 'Add these sources to your source list?',
    addSourceBtn: 'Add',
    ignoreBtn: 'Ignore',
    regeneratingReport: 'Regenerating report...',
    urlDetected: 'URL detected — content will be scraped',
    // Diff
    diffTitle: 'Version Comparison',
    added: 'Added',
    removed: 'Removed',
    close: 'Close',
    quotaExhausted: 'AI model quota exhausted. Please try again later or upgrade your plan.',
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
