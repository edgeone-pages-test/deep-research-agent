'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { marked } from 'marked';
import { useI18n } from '@/lib/i18n';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

interface SuggestedSource {
  title: string;
  url?: string;
  year?: number;
  authors?: string;
}

interface FollowUpChatProps {
  onRegenerate: (chatSummary: string) => void;
  onAddSource?: (source: SuggestedSource) => void;
  isRegenerating: boolean;
  projectId: string;
  report: string;
  conversationId: string;
  completionTick?: number;
}

export function FollowUpChat({ onRegenerate, onAddSource, isRegenerating, projectId, report, conversationId, completionTick = 0 }: FollowUpChatProps) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [regenerateSuggestion, setRegenerateSuggestion] = useState('');
  const [suggestedSources, setSuggestedSources] = useState<SuggestedSource[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const chatLoaded = useRef(false);
  const lastHandledTickRef = useRef(-1);

  // Post a completion message when research/regeneration finishes
  useEffect(() => {
    if (completionTick > 0 && completionTick !== lastHandledTickRef.current) {
      lastHandledTickRef.current = completionTick;
      setMessages(prev => [...prev, {
        id: `assistant-done-${Date.now()}`,
        role: 'assistant' as const,
        content: t.regenerationComplete,
        isStreaming: false,
      }]);
    }
  }, [completionTick, t.regenerationComplete]);

  // Load chat history from Blob on mount
  useEffect(() => {
    if (!projectId || chatLoaded.current) return;
    chatLoaded.current = true;
    (async () => {
      try {
        const res = await fetch('/project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_chat', id: projectId }),
        });
        if (res.ok) {
          const { messages: saved } = await res.json();
          if (Array.isArray(saved) && saved.length > 0) {
            setMessages(saved);
          }
        }
      } catch {}
    })();
  }, [projectId]);

  // Save chat history to Blob whenever messages change (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref to latest messages so the cleanup function can flush on unmount
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const flushSave = useCallback((msgs: ChatMessage[]) => {
    const toSave = msgs.filter(m => !m.isStreaming && m.content);
    if (!projectId || toSave.length === 0) return;
    fetch('/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_chat', id: projectId, messages: toSave }),
    }).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!projectId || messages.length === 0) return;
    // Debounce saves to avoid spamming the API
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      flushSave(messagesRef.current);
    }, 2000);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [messages, projectId, flushSave]);

  // Flush immediately on unmount so messages aren't lost when research restarts
  useEffect(() => {
    return () => { flushSave(messagesRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => { scrollToBottom(); }, [messages]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading || isRegenerating) return;

    const userMessage = input.trim();
    setInput('');
    setShowRegenerate(false);

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userMessage,
    };

    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsLoading(true);

    try {
      const chatHistory = messages.map(m => ({ role: m.role, content: m.content }));

      const response = await fetch('/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'makers-conversation-id': conversationId,
        },
        body: JSON.stringify({
          message: userMessage,
          chatHistory,
          report,
        }),
      });

      if (!response.ok) throw new Error(`Chat failed: ${response.statusText}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';

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

            if (event.type === 'chat_response') {
              fullContent += event.content;
              // Strip markers from displayed content
              const displayContent = fullContent
                .replace(/\[SUGGEST_REGENERATE\]/g, '')
                .replace(/\[SUGGEST_ADD_SOURCE\]\{[^\n]*\}/g, '')
                .trimEnd();
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantMsg.id
                    ? { ...m, content: displayContent }
                    : m
                )
              );
            } else if (event.type === 'suggest_regenerate') {
              setShowRegenerate(true);
              setRegenerateSuggestion(event.suggestion || '');
            } else if (event.type === 'suggest_add_source') {
              if (event.source) {
                setSuggestedSources(prev => [...prev, event.source]);
              }
            } else if (event.type === 'error_message') {
              fullContent += `\n\n⚠️ ${event.content}`;
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantMsg.id
                    ? { ...m, content: fullContent }
                    : m
                )
              );
            }
          } catch {}
        }
      }

      // Mark streaming as done
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMsg.id
            ? { ...m, isStreaming: false }
            : m
        )
      );
    } catch (e) {
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMsg.id
            ? { ...m, content: `⚠️ ${(e as Error).message}`, isStreaming: false }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerate = useCallback(() => {
    // Use only the AI's concise one-sentence suggestion as the modification request.
    // Sending the full chat history confuses the report-editor agent with conversational noise.
    // Fall back to the user's last message if no suggestion exists.
    const summary = regenerateSuggestion ||
      messages.filter(m => m.role === 'user').slice(-1).map(m => m.content).join('');
    onRegenerate(summary);
    setShowRegenerate(false);
  }, [messages, regenerateSuggestion, onRegenerate]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {t.continueResearch}
          </span>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {t.continueResearchSubtitle}
          </span>
        </div>
      </div>

      {/* Messages */}
      {messages.length > 0 && (
        <div className="max-h-96 overflow-y-auto p-4 space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-md'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 rounded-bl-md'
                }`}
              >
                {msg.content ? (
                  msg.role === 'assistant' ? (
                    <div className="prose prose-sm dark:prose-invert prose-p:my-1 prose-li:my-0.5 prose-headings:my-2 max-w-none break-words" dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) as string }} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  )
                ) : msg.isStreaming ? (
                  <span className="inline-flex items-center gap-1 text-neutral-400">
                    <span className="animate-pulse">●</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>●</span>
                    <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>●</span>
                  </span>
                ) : null}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Regenerate Button */}
      {showRegenerate && !isRegenerating && (
        <div className="mx-4 mb-3">
          <button
            onClick={handleRegenerate}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white text-sm font-medium shadow-sm transition-all hover:shadow-md"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {t.regenerateReport}
            {regenerateSuggestion && (
              <span className="opacity-75 ml-1">— {regenerateSuggestion.slice(0, 30)}{regenerateSuggestion.length > 30 ? '...' : ''}</span>
            )}
          </button>
        </div>
      )}

      {/* Suggested Sources — ask user to add to left panel */}
      {suggestedSources.length > 0 && onAddSource && (
        <div className="mx-4 mb-3 space-y-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 font-medium">{t.suggestedSources}</p>
          {suggestedSources.map((source, i) => (
            <div
              key={i}
              className="flex items-center gap-2 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">{source.title}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {[source.authors, source.year, source.url && new URL(source.url).hostname].filter(Boolean).join(' · ')}
                </p>
              </div>
              <button
                onClick={() => {
                  onAddSource(source);
                  setSuggestedSources(prev => prev.filter((_, idx) => idx !== i));
                }}
                className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium transition-colors"
              >
                {t.addSourceBtn}
              </button>
              <button
                onClick={() => {
                  setSuggestedSources(prev => prev.filter((_, idx) => idx !== i));
                }}
                className="flex-shrink-0 px-2 py-1.5 rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-500 text-xs transition-colors"
              >
                {t.ignoreBtn}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Regenerating indicator */}
      {isRegenerating && (
        <div className="mx-4 mb-3 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-neutral-100 dark:bg-neutral-800 text-sm text-neutral-600 dark:text-neutral-400">
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {t.regeneratingReport}
        </div>
      )}

      {/* Input Area */}
      <div className="p-4 border-t border-neutral-100 dark:border-neutral-800">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            placeholder={t.chatInputPlaceholder}
            className="flex-1 min-h-[44px] max-h-32 px-4 py-2.5 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 text-sm text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 resize-none transition-all"
            disabled={isLoading || isRegenerating}
            rows={1}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading || isRegenerating}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-neutral-700 dark:hover:bg-neutral-300 transition-colors"
          >
            {isLoading ? (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
