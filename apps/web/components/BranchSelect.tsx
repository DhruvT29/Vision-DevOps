'use client';

import { useEffect, useRef, useState } from 'react';

/** Themed replacement for the native <select> used to pick a git branch. */
export function BranchSelect({
  branches,
  value,
  defaultBranch,
  onChange,
}: {
  branches: string[];
  value: string;
  defaultBranch?: string;
  onChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setFilter('');
      filterRef.current?.focus();
    }
  }, [open]);

  const visible = branches.filter((b) => b.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div ref={rootRef} className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none transition hover:border-zinc-700 focus:border-zinc-600"
      >
        <span className="truncate font-mono text-zinc-200">{value}</span>
        <span className="flex shrink-0 items-center gap-2">
          {value === defaultBranch && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              default
            </span>
          )}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-150 ${
              open ? 'rotate-180' : ''
            }`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/50">
          <div className="border-b border-zinc-800 p-1.5">
            <input
              ref={filterRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branches…"
              spellCheck={false}
              className="w-full rounded-md border border-transparent bg-zinc-950 px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-700"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {visible.length === 0 && (
              <li className="px-3 py-2 text-xs text-zinc-500">No branches match</li>
            )}
            {visible.map((b) => (
              <li key={b}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(b);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-xs transition ${
                    b === value
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100'
                  }`}
                >
                  <span className="truncate">{b}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {b === defaultBranch && (
                      <span className="text-[10px] text-zinc-500">default</span>
                    )}
                    {b === value && (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        className="h-3.5 w-3.5 text-emerald-400"
                      >
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
