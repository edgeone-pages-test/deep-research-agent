'use client';

import { useState, useRef, useEffect } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

interface ReportViewProps {
  content: string;
  isStreaming: boolean;
}

export function ReportView({ content, isStreaming }: ReportViewProps) {
  const { t } = useI18n();
  const [showScrollTop, setShowScrollTop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      setShowScrollTop(el.scrollTop > 300);
    };

    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll during streaming
  useEffect(() => {
    if (isStreaming && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content, isStreaming]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
  };

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'research-report.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!content && !isStreaming) return null;

  return (
    <Card className="relative">
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="font-serif text-sm font-semibold text-neutral-900 dark:text-warm-100 flex items-center gap-2">
            <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {t.researchReport}
            {isStreaming && (
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse-dot" />
            )}
          </h3>

          {content && !isStreaming && (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleCopy}>
                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                {t.copy}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDownload}>
                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {t.download}
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div
          ref={containerRef}
          className="max-h-[70vh] overflow-y-auto pr-2 relative"
        >
          {/* Loading state when waiting for report content */}
          {isStreaming && !content && (
            <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 py-4">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t.generatingReport}
            </div>
          )}
          {content && (
            <div className="prose-research max-w-prose" dangerouslySetInnerHTML={{ __html: marked.parse(content) as string }} />
          )}
        </div>

        {/* Scroll to top button */}
        {showScrollTop && (
          <button
            onClick={scrollToTop}
            className="absolute bottom-6 right-6 w-8 h-8 rounded-full bg-neutral-900 dark:bg-warm-100 text-white dark:text-neutral-900 flex items-center justify-center shadow-lg hover:scale-110 transition-transform"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
      </CardContent>
    </Card>
  );
}
