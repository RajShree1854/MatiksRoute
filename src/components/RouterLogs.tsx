'use client';

import { useEffect, useRef, useState } from 'react';
import { AnyRoutingEvent, QuotaStatus } from '@/providers/types';

interface LogEntry {
  id: string;
  timestamp: number;
  event: AnyRoutingEvent;
}

interface Props {
  events: AnyRoutingEvent[];
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: 'text-emerald-400',
  gemini: 'text-blue-400',
  groq: 'text-purple-400',
};

const TIER_STYLES: Record<string, { label: string; color: string; dot: string }> = {
  simple: { label: 'SIMPLE', color: 'text-green-400', dot: 'bg-green-400' },
  medium: { label: 'MEDIUM', color: 'text-amber-400', dot: 'bg-amber-400' },
  hard: { label: 'HARD', color: 'text-red-400', dot: 'bg-red-400' },
};

function EventRow({ event }: { event: AnyRoutingEvent }) {
  if (event.type === 'meta') {
    const tier = TIER_STYLES[event.tier] ?? TIER_STYLES.simple;
    const pc = PROVIDER_COLORS[event.provider] ?? 'text-white/60';
    return (
      <div className="flex flex-col gap-1 p-3 bg-white/5 rounded-xl border border-white/10 animate-slideIn">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${tier.dot} flex-shrink-0`} />
          <span className={`text-xs font-bold font-mono ${tier.color}`}>{tier.label}</span>
          <span className="text-white/30 text-xs">→</span>
          <span className={`text-xs font-semibold ${pc}`}>{event.provider}</span>
        </div>
        <div className="flex gap-3 text-[11px] text-white/40 font-mono mt-0.5">
          <span>{event.originalTokens} → {event.compressedTokens} tk</span>
          {event.originalTokens > 0 && (
            <span className="text-green-400/70">
              -{Math.round(((event.originalTokens - event.compressedTokens) / event.originalTokens) * 100)}%
            </span>
          )}
          {event.hadImages && <span className="text-blue-400/70">🖼️ {event.imageAction}</span>}
        </div>
      </div>
    );
  }


  if (event.type === 'fallback') {
    const fromColor = PROVIDER_COLORS[event.from] ?? 'text-white/60';
    const toColor = PROVIDER_COLORS[event.to] ?? 'text-white/60';
    return (
      <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-xl border border-red-500/20 animate-slideIn">
        <span className="text-red-400 text-sm">⚡</span>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-red-400">Fallback Triggered</span>
          <span className="text-[11px] font-mono text-white/50">
            <span className={fromColor}>{event.from}</span>
            <span className="text-white/30"> failed → </span>
            <span className={toColor}>{event.to}</span>
          </span>
        </div>
      </div>
    );
  }

  if (event.type === 'mid_stream_failover') {
    const fromColor = PROVIDER_COLORS[event.from] ?? 'text-white/60';
    const toColor = PROVIDER_COLORS[event.to] ?? 'text-white/60';
    return (
      <div className="flex items-center gap-2 p-3 bg-orange-500/10 rounded-xl border border-orange-500/20 animate-slideIn">
        <span className="text-orange-400 text-sm">🔀</span>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-orange-400">Mid-Stream Failover</span>
          <span className="text-[11px] font-mono text-white/50">
            <span className={fromColor}>{event.from}</span>
            <span className="text-white/30"> dropped after {event.tokensStreamedBeforeFailure} tokens → </span>
            <span className={toColor}>{event.to}</span>
          </span>
        </div>
      </div>
    );
  }

  if (event.type === 'done') {
    const pc = PROVIDER_COLORS[event.provider] ?? 'text-white/60';
    return (
      <div className="flex items-center gap-2 p-3 bg-green-500/10 rounded-xl border border-green-500/20 animate-slideIn">
        <span className="text-green-400 text-sm">✅</span>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-green-400">Done</span>
          <span className="text-[11px] font-mono text-white/50">
            <span className={pc}>{event.provider}</span>
            <span className="text-white/30"> · {event.latencyMs}ms · {event.tokensUsed} tokens</span>
            {event.fallbackCount > 0 && (
              <span className="text-red-400/70"> · {event.fallbackCount} fallback(s)</span>
            )}
            {event.midStreamFailover && (
              <span className="text-orange-400/70"> · mid-stream failover</span>
            )}
          </span>
        </div>
      </div>
    );
  }

  return null;
}

function ProviderHealthCard({ status }: { status: QuotaStatus }) {
  const isAvailable = status.available;
  const cooldownSecs = status.cooldownUntil
    ? Math.max(0, Math.ceil((status.cooldownUntil - Date.now()) / 1000))
    : 0;

  const colors: Record<string, { ring: string; text: string }> = {
    openai: { ring: 'ring-emerald-500/40', text: 'text-emerald-400' },
    gemini: { ring: 'ring-blue-500/40', text: 'text-blue-400' },
    groq: { ring: 'ring-purple-500/40', text: 'text-purple-400' },
  };
  const c = colors[status.provider] ?? { ring: 'ring-white/20', text: 'text-white/60' };

  return (
    <div className={`p-3 rounded-xl bg-white/5 border border-white/10 ring-1 ${c.ring}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-xs font-semibold ${c.text} capitalize`}>{status.provider}</span>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${isAvailable
          ? 'bg-green-500/20 text-green-400'
          : 'bg-red-500/20 text-red-400'
          }`}>
          {isAvailable ? '● LIVE' : `⏸ ${cooldownSecs}s`}
        </span>
      </div>
      <div className="text-[10px] text-white/40 font-mono space-y-0.5">
        <div className="flex justify-between">
          <span>TPM used</span>
          <span>{status.tokensUsedThisMinute.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Total requests</span>
          <span>{status.totalRequests}</span>
        </div>
      </div>
    </div>
  );
}

export default function RouterLogs({ events }: Props) {
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [quotaStatuses, setQuotaStatuses] = useState<QuotaStatus[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1];
    setLogEntries((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, timestamp: Date.now(), event: latest },
    ]);
    setTimeout(() => {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  }, [events]);

  useEffect(() => {
    const fetchQuota = async () => {
      try {
        const res = await fetch('/api/quota');
        if (res.ok) setQuotaStatuses(await res.json());
      } catch { /* non-critical */ }
    };
    fetchQuota();
    const id = setInterval(fetchQuota, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Activity Feed */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest">
            Router Activity
          </h2>
          {logEntries.length > 0 && (
            <button
              onClick={() => setLogEntries([])}
              className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
          {logEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-2 py-8">
              <span className="text-3xl opacity-40">📡</span>
              <p className="text-white/30 text-xs max-w-[180px]">
                Routing events will appear here as you chat
              </p>
            </div>
          ) : (
            logEntries.map((entry) => (
              <EventRow key={entry.id} event={entry.event} />
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* Provider Health */}
      <div className="flex-shrink-0 border-t border-white/10">
        <div className="px-4 py-3 border-b border-white/10">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest">
            Provider Health
          </h2>
        </div>
        <div className="p-4 space-y-3">
          {quotaStatuses.length === 0
            ? ['openai', 'gemini', 'groq'].map((p) => (
              <div key={p} className="h-16 rounded-xl bg-white/5 animate-pulse" />
            ))
            : quotaStatuses.map((s) => (
              <ProviderHealthCard key={s.provider} status={s} />
            ))}
        </div>
      </div>
    </div>
  );
}
