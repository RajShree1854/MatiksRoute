'use client';

import { useCallback, useRef, useState } from 'react';
import { AnyRoutingEvent, ChatMessage, ContentPart } from '@/providers/types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  imagePreview?: string; // base64 data URL for display
  providerUsed?: string;
  streaming?: boolean;
}

interface Props {
  onRoutingEvent: (event: AnyRoutingEvent) => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ChatPanel({ onRoutingEvent }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState<string | null>(null); // base64 data URL
  const [isStreaming, setIsStreaming] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleImageSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    const dataUrl = await readFileAsDataUrl(file);
    setPendingImage(dataUrl);
    // Reset file input so the same file can be re-selected
    e.target.value = '';
  }, []);

  const removePendingImage = useCallback(() => {
    setPendingImage(null);
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if ((!text && !pendingImage) || isStreaming) return;

    // Build the display message for the UI
    const userMessage: Message = {
      role: 'user',
      content: text,
      imagePreview: pendingImage ?? undefined,
    };
    const assistantMessage: Message = { role: 'assistant', content: '', streaming: true };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput('');
    setPendingImage(null);
    setIsStreaming(true);
    setTimeout(scrollToBottom, 50);

    // Build the API payload — use ContentPart array when image is present
    const buildUserContent = (msgText: string, imgDataUrl: string | null): string | ContentPart[] => {
      if (!imgDataUrl) return msgText;
      const parts: ContentPart[] = [];
      if (msgText) parts.push({ type: 'text', text: msgText });
      parts.push({ type: 'image_url', image_url: { url: imgDataUrl, detail: 'auto' } });
      return parts;
    };

    const apiMessages: ChatMessage[] = [
      ...messages.map((m) => ({
        role: m.role,
        content: m.imagePreview
          ? buildUserContent(m.content, m.imagePreview)
          : m.content,
      })),
      { role: 'user', content: buildUserContent(text, pendingImage) },
    ];

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Gateway error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let assistantContent = '';
      let providerUsed: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const json = trimmed.slice(5).trim();
          if (!json || json === '[DONE]') continue;

          try {
            const event = JSON.parse(json) as AnyRoutingEvent;
            onRoutingEvent(event);

            if (event.type === 'token') {
              assistantContent += event.content;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: assistantContent,
                };
                return updated;
              });
              scrollToBottom();
            } else if (event.type === 'meta') {
              providerUsed = event.provider;
            } else if (event.type === 'done') {
              providerUsed = event.provider;
            }
          } catch {
            // Skip malformed SSE events
          }
        }
      }

      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          streaming: false,
          providerUsed,
        };
        return updated;
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `⚠️ Error: ${errorMessage}`,
          streaming: false,
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  }, [input, pendingImage, isStreaming, messages, onRoutingEvent, scrollToBottom]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, []);

  const canSend = (input.trim().length > 0 || pendingImage !== null) && !isStreaming;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-white/10">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Chat</h2>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-16">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/20 flex items-center justify-center text-3xl">
              🤖
            </div>
            <p className="text-white/40 text-sm max-w-xs">
              Send a message or attach an image to see intelligent routing in action.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-lg bg-indigo-500/30 flex items-center justify-center text-xs flex-shrink-0 mt-0.5">
                🤖
              </div>
            )}
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === 'user'
                  ? 'bg-indigo-600/80 text-white ml-auto'
                  : 'bg-white/5 text-white/90 border border-white/10'
                }`}
            >
              {/* Image preview inside message bubble */}
              {msg.imagePreview && (
                <img
                  src={msg.imagePreview}
                  alt="attached"
                  className="max-w-full max-h-48 rounded-xl mb-2 object-contain"
                />
              )}
              {msg.content && (
                <p className="whitespace-pre-wrap break-words">
                  {msg.content}
                  {msg.streaming && (
                    <span className="inline-block w-0.5 h-4 bg-indigo-400 ml-0.5 animate-pulse align-middle" />
                  )}
                </p>
              )}
              {/* Streaming cursor when only image, no text yet */}
              {!msg.content && msg.streaming && (
                <span className="inline-block w-0.5 h-4 bg-indigo-400 animate-pulse align-middle" />
              )}
              {msg.providerUsed && !msg.streaming && (
                <p className="mt-2 text-[10px] text-white/30 font-mono">
                  via {msg.providerUsed}
                </p>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-lg bg-indigo-600/40 flex items-center justify-center text-xs flex-shrink-0 mt-0.5">
                👤
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-4 border-t border-white/10">
        {/* Pending image preview */}
        {pendingImage && (
          <div className="relative inline-flex mb-2 ml-1">
            <img
              src={pendingImage}
              alt="pending"
              className="h-16 w-16 rounded-xl object-cover border border-white/20"
            />
            <button
              onClick={removePendingImage}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center text-[9px] text-white transition-colors"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex gap-2 items-end bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus-within:border-indigo-500/50 transition-colors">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageSelect}
          />

          {/* Image attach button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            title="Attach image"
            className="flex-shrink-0 w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center text-white/50 hover:text-white/80"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            rows={1}
            autoFocus
            className="flex-1 bg-transparent text-white/90 placeholder-white/30 text-sm resize-none outline-none min-h-[24px] max-h-[160px] font-sans leading-relaxed"
          />

          {/* Send button */}
          <button
            onClick={sendMessage}
            disabled={!canSend}
            className="flex-shrink-0 w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center text-white"
          >
            {isStreaming ? (
              <span className="w-3 h-3 border-2 border-white/50 border-t-white rounded-full animate-spin" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
