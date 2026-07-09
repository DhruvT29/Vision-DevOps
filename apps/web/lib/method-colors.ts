/** Tailwind classes per HTTP method, used by badges across the app. */
export const METHOD_BADGE: Record<string, string> = {
  GET: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  POST: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  PUT: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  PATCH: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  DELETE: 'bg-red-500/15 text-red-400 border-red-500/30',
  HEAD: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  OPTIONS: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  ALL: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

export function methodBadge(method: string): string {
  return METHOD_BADGE[method] ?? METHOD_BADGE.ALL;
}
