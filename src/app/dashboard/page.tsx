'use client';

import { useCallback, useState } from 'react';
import ChatPanel from '@/components/ChatPanel';
import RouterLogs from '@/components/RouterLogs';
import { AnyRoutingEvent } from '@/providers/types';

export default function DashboardPage() {
  const [events, setEvents] = useState<AnyRoutingEvent[]>([]);

  const handleRoutingEvent = useCallback((event: AnyRoutingEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  return (
    <div className="h-screen overflow-hidden bg-[#070711] text-white flex flex-col">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-white/10 bg-black/20 backdrop-blur-sm px-6 py-4">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-sm">
              ⚡
            </div>
            <div>
              <h1 className="text-base font-bold text-white leading-none">MatiksRoute</h1>
              <p className="text-[11px] text-white/40 mt-0.5">Intelligent AI Gateway</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              {[
                { name: 'OpenAI', color: 'bg-emerald-400' },
                { name: 'Gemini', color: 'bg-blue-400' },
                { name: 'Groq', color: 'bg-purple-400' },
              ].map(({ name, color }) => (
                <div key={name} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
                  <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
                  <span className="text-[11px] text-white/60 font-medium">{name}</span>
                </div>
              ))}
            </div>

            <div className="text-[11px] text-white/30 font-mono px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
              localhost:3000
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden max-w-[1600px] w-full mx-auto">
        {/* Chat Panel — 60% */}
        <div className="flex-1 border-r border-white/10 min-h-0 overflow-hidden">
          <ChatPanel onRoutingEvent={handleRoutingEvent} />
        </div>

        {/* Right Panel — 40% */}
        <div className="w-[400px] flex-shrink-0 min-h-0 overflow-hidden">
          <RouterLogs events={events} />
        </div>
      </main>
    </div>
  );
}
