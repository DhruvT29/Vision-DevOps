'use client';

import { useState } from 'react';
import type { EnvironmentSummary } from '@vision/shared';
import { api } from '@/lib/api';

export function EnvPicker({
  envs,
  envId,
  onSelect,
  projectId,
  onCreated,
}: {
  envs: EnvironmentSummary[];
  envId: string;
  onSelect: (id: string) => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', baseUrl: '', token: '' });

  async function create() {
    if (!form.name || !form.baseUrl) return;
    const created = await api.createEnvironment(projectId, {
      name: form.name,
      baseUrl: form.baseUrl,
      auth: form.token ? { type: 'bearer', token: form.token } : { type: 'none' },
    });
    setForm({ name: '', baseUrl: '', token: '' });
    setOpen(false);
    onCreated();
    onSelect(created.id);
  }

  return (
    <div className="relative flex items-center gap-1.5">
      <select
        value={envId}
        onChange={(e) => onSelect(e.target.value)}
        className="max-w-56 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs outline-none focus:border-zinc-600"
      >
        <option value="">no environment</option>
        {envs.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} — {e.baseUrl}
          </option>
        ))}
      </select>
      <button
        onClick={() => setOpen((s) => !s)}
        title="New environment"
        className="rounded-lg border border-zinc-800 px-2 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600"
      >
        +
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 flex w-72 flex-col gap-2 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl">
          <input
            placeholder="name (e.g. local)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs outline-none focus:border-zinc-600"
          />
          <input
            placeholder="base URL (e.g. http://localhost:8001)"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            spellCheck={false}
            className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-zinc-600"
          />
          <input
            placeholder="bearer token (optional)"
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
            spellCheck={false}
            className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-zinc-600"
          />
          <button
            onClick={create}
            disabled={!form.name || !form.baseUrl}
            className="rounded bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}
