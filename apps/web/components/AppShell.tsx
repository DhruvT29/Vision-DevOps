'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { SnapshotStats } from '@vision/shared';
import { BranchSwitcher } from './BranchSwitcher';

/**
 * Chrome for all in-project pages: top navbar (centered wordmark + snapshot
 * stats on the right) and the collapsible navigation rail on the left.
 */
export function AppShell({
  snapshotId,
  stats,
  children,
}: {
  snapshotId: string;
  stats?: SnapshotStats;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col">
      <header className="relative flex h-12 shrink-0 items-center border-b border-zinc-800 px-4">
        <BranchSwitcher snapshotId={snapshotId} />
        <Link
          href="/"
          className="absolute left-1/2 -translate-x-1/2 pl-[1.5em] text-sm font-bold tracking-[1.5em] text-zinc-100 transition hover:text-white"
        >
          VISION
        </Link>
        {stats && (
          <span className="ml-auto text-xs text-zinc-500">
            {stats.modules} modules · {stats.endpoints} endpoints
            {stats.frontendCalls > 0 && ` · ${stats.frontendCalls} calls`}
          </span>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <NavSidebar snapshotId={snapshotId} />
        <div className="relative flex min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

const NAV_COLLAPSED_KEY = 'vision:nav-collapsed';

function NavSidebar({ snapshotId }: { snapshotId: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Read persisted state after mount to avoid an SSR hydration mismatch.
  useEffect(() => {
    setCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY) === '1');
  }, []);

  function toggle() {
    setCollapsed((c) => {
      localStorage.setItem(NAV_COLLAPSED_KEY, c ? '0' : '1');
      return !c;
    });
  }

  const items = [
    { href: `/project/${snapshotId}`, label: 'Home', icon: <HomeIcon /> },
    { href: `/graph/${snapshotId}`, label: 'Endpoint Graph', icon: <GraphIcon /> },
    { href: `/dependencies/${snapshotId}`, label: 'Dependency Graph', icon: <DependencyIcon /> },
    { href: `/db-blast/${snapshotId}`, label: 'DB Blast Analysis', icon: <DatabaseIcon /> },
    { href: `/insights/${snapshotId}`, label: 'Insights', icon: <InsightsIcon /> },
    { href: `/deploy/${snapshotId}`, label: 'Deployment', icon: <RocketIcon /> },
    { href: `/db-schema/${snapshotId}`, label: 'Database Schema', icon: <SchemaIcon /> },
  ];

  return (
    <nav
      className={`flex shrink-0 flex-col border-r border-zinc-800 py-2 transition-[width] duration-200 ${
        collapsed ? 'w-12' : 'w-52'
      }`}
    >
      <div className="flex flex-1 flex-col gap-1 px-2">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={`flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg px-2 py-2 text-sm transition ${
                active
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </div>
      <button
        onClick={toggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="mx-2 flex items-center justify-center rounded-lg px-2 py-2 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`h-4 w-4 transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
    </nav>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M7 7.5 10.5 16M17 7.5 13.5 16" />
    </svg>
  );
}

function DependencyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M12 6.5h3.5a2 2 0 0 1 2 2V12" />
      <path d="M12 17.5H8.5a2 2 0 0 1-2-2V12" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

function InsightsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  );
}

function SchemaIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11M3 14h18" />
    </svg>
  );
}

function RocketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}
