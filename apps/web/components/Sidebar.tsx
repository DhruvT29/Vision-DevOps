'use client';

import { useState } from 'react';
import { CollectionsPane } from '@/components/CollectionsPane';
import { ScenariosPane } from '@/components/ScenariosPane';

export function Sidebar({ projectId, envId }: { projectId: string; envId: string }) {
  const [tab, setTab] = useState<'collections' | 'scenarios'>('collections');

  return (
    <aside className="z-10 flex h-full w-80 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/95">
      <div className="flex gap-1 border-b border-zinc-800 p-2">
        {(['collections', 'scenarios'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition ${
              tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === 'collections' ? (
          <CollectionsPane projectId={projectId} envId={envId} />
        ) : (
          <ScenariosPane projectId={projectId} envId={envId} />
        )}
      </div>
    </aside>
  );
}
