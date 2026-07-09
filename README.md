# Vision

A locally-run web app that opens a project directory, builds an interactive knowledge
graph of its modules and API endpoints, and lets you test those APIs — Postman-style
collections, environments, chaining, and assertions included.

## Architecture

| Piece | Tech | Port | Role |
|---|---|---|---|
| `apps/web` | Next.js 15 (App Router) + React 19 + Tailwind 4 | 3000 | Graph UI, request builder, collections |
| `apps/engine` | NestJS 11 + Prisma (SQLite) + ts-morph | 4000 | Filesystem access, static analysis, request runner |
| `packages/shared` | `.d.ts` types only | — | Contract between web and engine |

The engine is the only process that touches disk and the only one that calls the
target project's API (avoids CORS, keeps tokens off the browser).

## Development

```bash
pnpm install
pnpm --filter @vision/engine prisma:migrate   # first time: creates SQLite dev.db
pnpm dev                                       # boots web (:3000) + engine (:4000)
```

## How analysis works

Static AST analysis via ts-morph — the target project never runs:

- **NestJS**: `@Controller`/`@Get`/`@Post`... decorators → endpoints; `*.module.ts`
  `controllers: []` → module grouping; `main.ts` `setGlobalPrefix` → path prefix;
  `@UseGuards`/`@Roles` (class + method level) → auth requirements; `@Body()` DTO
  types resolved through imports → body schemas.
- **Next.js**: `app/**/route.ts` + `pages/api/**` → endpoints.
- **Frontend**: axios/fetch call sites → best-effort linked to backend endpoints
  (confidence-scored `calls` edges, manual override in UI).

Scans hard-exclude `node_modules`, `.next`, `dist`, `build`.
