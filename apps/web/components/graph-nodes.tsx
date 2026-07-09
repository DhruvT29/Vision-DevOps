'use client';

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { Endpoint, FrontendCall, ModuleNode as ModuleNodeData } from '@vision/shared';
import { methodBadge } from '@/lib/method-colors';

export const MODULE_NODE_SIZE = { width: 240, height: 64 };
export const ENDPOINT_NODE_SIZE = { width: 300, height: 48 };

export type ModuleFlowNode = Node<{ module: ModuleNodeData; expanded: boolean }, 'module'>;
export type EndpointFlowNode = Node<{ endpoint: Endpoint; selected: boolean }, 'endpoint'>;
export type CallFlowNode = Node<{ call: FrontendCall }, 'call'>;

const KIND_STYLE: Record<string, { expanded: string; label: string; glow: string }> = {
  'nest-module': {
    expanded: 'border-sky-500/60 bg-sky-950/60 shadow-lg shadow-sky-500/10',
    label: 'text-sky-500/80',
    glow: 'hover:border-sky-400/60 hover:shadow-[0_0_40px_-6px_rgba(14,165,233,0.5)]',
  },
  'next-api-group': {
    expanded: 'border-emerald-500/60 bg-emerald-950/60 shadow-lg shadow-emerald-500/10',
    label: 'text-emerald-500/80',
    glow: 'hover:border-emerald-400/60 hover:shadow-[0_0_40px_-6px_rgba(16,185,129,0.5)]',
  },
  'react-feature': {
    expanded: 'border-violet-500/60 bg-violet-950/60 shadow-lg shadow-violet-500/10',
    label: 'text-violet-400/80',
    glow: 'hover:border-violet-400/60 hover:shadow-[0_0_40px_-6px_rgba(139,92,246,0.5)]',
  },
};

export function ModuleGraphNode({ data }: NodeProps<ModuleFlowNode>) {
  const { module: mod, expanded } = data;
  const style = KIND_STYLE[mod.kind] ?? KIND_STYLE['nest-module'];
  return (
    <div
      className={`module-card flex h-16 w-60 cursor-pointer items-center justify-between rounded-xl border px-4 backdrop-blur-xl ${
        expanded
          ? style.expanded
          : `border-[rgba(144,161,255,0.17)] bg-[rgba(65,65,65,0.11)] ${style.glow}`
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-zinc-100">
          {mod.name.replace(/Module$/, '')}
        </div>
        <div className={`text-[10px] uppercase tracking-wider ${style.label}`}>{mod.kind}</div>
      </div>
      <span className="ml-2 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">
        {mod.endpointCount}
      </span>
      {mod.kind === 'react-feature' ? (
        <Handle type="source" position={Position.Right} className="!bg-violet-600" />
      ) : (
        <>
          <Handle type="target" position={Position.Left} className="!bg-zinc-600" />
          <Handle type="source" position={Position.Right} className="!bg-zinc-600" />
        </>
      )}
    </div>
  );
}

export function CallGraphNode({ data }: NodeProps<CallFlowNode>) {
  const { call } = data;
  return (
    <div
      className="flex h-12 w-[300px] cursor-pointer items-center gap-2 rounded-lg border border-violet-900/60 bg-violet-950/30 px-3 transition hover:border-violet-500/60"
      title={`${call.callerSymbol} — click to jump to the backend endpoint`}
    >
      <Handle type="target" position={Position.Left} className="!bg-violet-600" />
      <span
        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${methodBadge(call.method)}`}
      >
        {call.method}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-zinc-300">
          {call.resolvedPath ?? call.rawUrl}
        </div>
        <div className="truncate text-[9px] text-violet-400/70">{call.callerSymbol}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-violet-600" />
    </div>
  );
}

export function EndpointGraphNode({ data }: NodeProps<EndpointFlowNode>) {
  const { endpoint: ep, selected } = data;
  // strip the module segment for compactness; keep from the base resource on
  return (
    <div
      className={`flex h-12 w-[300px] cursor-pointer items-center gap-2 rounded-lg border px-3 transition ${
        selected
          ? 'border-sky-400 bg-sky-950/80'
          : 'border-zinc-800 bg-zinc-900/90 hover:border-zinc-600'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-zinc-600" />
      <span
        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${methodBadge(ep.method)}`}
      >
        {ep.method}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">{ep.fullPath}</span>
      {ep.auth.required && (
        <span title={`Auth: ${ep.auth.guards.join(', ')}${ep.auth.roles.length ? ` — roles: ${ep.auth.roles.join(', ')}` : ''}`}>
          <svg className="h-3.5 w-3.5 text-amber-500/80" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z" />
          </svg>
        </span>
      )}
    </div>
  );
}

export const nodeTypes = {
  module: ModuleGraphNode,
  endpoint: EndpointGraphNode,
  call: CallGraphNode,
};
