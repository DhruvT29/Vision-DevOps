# How Vision Works — A Beginner's Guide

> You point Vision at a project folder on your computer. It reads the code (without
> running it), draws a map of every API the project has, shows you which frontend
> button talks to which backend door, and lets you fire real test requests at those
> doors — like Postman, but the requests build themselves.

This document explains how all of that works, assuming you know nothing about the
project or the concepts inside it.

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Why Two Apps? (web + engine)](#2-why-two-apps)
3. [Concepts Crash Course](#3-concepts-crash-course)
4. [What Happens When You Open a Project](#4-what-happens-when-you-open-a-project)
5. [How Vision Reads Code Without Running It](#5-how-vision-reads-code-without-running-it)
6. [Finding Frontend Calls & Linking the Two Worlds](#6-finding-frontend-calls--linking-the-two-worlds)
7. [The Graph Screen Explained](#7-the-graph-screen-explained)
8. [Testing an API: Environments & the Runner](#8-testing-an-api-environments--the-runner)
9. [Collections & Assertions](#9-collections--assertions)
10. [Scenarios: Chaining Requests Together](#10-scenarios-chaining-requests-together)
11. [Where Everything Is Stored](#11-where-everything-is-stored)
12. [Folder Map of This Repo](#12-folder-map-of-this-repo)
13. [Glossary](#13-glossary)

---

## 1. The Big Picture

Think of Vision as **an X-ray machine + a remote control** for your projects:

- **X-ray**: it looks *inside* a project's source code and produces a map
  (the "knowledge graph") of all its modules and API endpoints.
- **Remote control**: from that map, you can press buttons — send real HTTP
  requests to the project while it's running, and check the answers.

```
                     YOU
                      │  "open C:\...\annpriya"
                      ▼
   ┌───────────────────────────────────────────┐
   │                 VISION                    │
   │                                           │
   │   1. reads the project's source code      │
   │   2. draws an interactive map of it       │
   │   3. lets you test its APIs for real      │
   └───────────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
   your project's code     your project RUNNING
   (read from disk,        (real HTTP requests
    never executed)         sent to it)
```

The key trick: steps 1–2 need **only the code on disk**. The target project does
not need to be running, installed, or even working. Only step 3 (testing) needs
the target actually running somewhere.

---

## 2. Why Two Apps?

Vision is not one program — it's **two programs that talk to each other**, plus a
small shared "dictionary" package:

```
 ┌────────────────────────┐        HTTP         ┌────────────────────────────┐
 │   apps/web             │  ◄───────────────►  │   apps/engine              │
 │   (Next.js + React)    │   localhost:4000    │   (NestJS)                 │
 │                        │                     │                            │
 │  what you SEE:         │                     │  what does the WORK:       │
 │  • the graph           │                     │  • reads folders/files     │
 │  • panels & buttons    │                     │  • parses source code      │
 │  • runs on :3000       │                     │  • stores results (SQLite) │
 │                        │                     │  • fires test requests     │
 └────────────────────────┘                     └────────────┬───────────────┘
              ▲                                              │
              │            packages/shared                   ▼
              └──────  (a shared "dictionary" of      your target project
                        TypeScript types both          (files on disk +
                        sides agree on)                running server)
```

**Why not just one app in the browser?** Two hard rules of web browsers force
the split:

1. **Browsers cannot read your disk.** A web page is sandboxed — it can't open
   `C:\Data Bank\...\annpriya` and read files. So *something outside the
   browser* must do the reading. That's the engine.

2. **Browsers block cross-site requests (CORS).** If the graph page (on
   `localhost:3000`) tried to directly call your target API (say
   `localhost:8001`), the browser would often block it, because the target
   server only accepts requests from origins it trusts. The engine is a normal
   program, not a browser — no such rule applies. So all test requests are sent
   *by the engine*, and the browser only talks to the engine.

   Bonus: your auth tokens stay inside the engine and its local database — they
   are never handed to browser code.

**What's `packages/shared`?** Both apps constantly exchange data ("here is an
endpoint", "here is a test result"). The shared package is a single file of
TypeScript *type definitions* — a contract that says exactly what shape each of
those objects has. If the engine changes a shape, the web app fails to compile
until it's updated too. It contains **types only, no actual code** — think of
it as a dictionary both sides must use, not a machine that does anything.

---

## 3. Concepts Crash Course

Skip this section if you already know these words.

### API endpoint
A single "door" into a backend server. It's identified by an **HTTP method**
(GET = read, POST = create, PATCH = change, DELETE = remove) plus a **path**:

```
GET    /api/addresses          → "give me all addresses"
POST   /api/addresses          → "create an address" (data travels in the body)
PATCH  /api/addresses/:id      → "change address number :id"
```

`:id` is a **path parameter** — a placeholder. The real request would be
`PATCH /api/addresses/42`.

### Module
A folder of related backend code. In NestJS projects (like annpriya's backend),
code is organized as one module per feature: `addresses/`, `orders/`,
`payments/`... Each module usually owns a **controller** — the file that
declares that feature's endpoints. In Vision's graph, **modules are the big
category nodes** and their endpoints are the sub-nodes.

### DTO (Data Transfer Object)
A class that describes what data an endpoint expects in its body:

```ts
class CreateAddressDto {
  address: string;        // required text
  latitude?: number;      // optional number
}
```

Vision reads these so it can pre-fill an example JSON body for you when testing.

### Guard / Auth
A rule attached to an endpoint saying "you must be logged in" (or "you must be
an ADMIN") to use it. Vision detects these and shows a 🔒 on protected
endpoints, so you know a request will need a token.

### Static analysis / AST
"Static" = *without running the code*. Vision never executes your project — it
reads the source files as **structured text**. See section 5.

---

## 4. What Happens When You Open a Project

You type a folder path and press **Open**. Here is the entire journey:

```
 YOU (browser, :3000)                ENGINE (:4000)                     DISK / DB
 ─────────────────────               ───────────────                    ──────────
 type path, press Open
        │
        │  POST /projects/open
        ├──────────────────────────►  1. does the folder exist?
        │                             2. STACK DETECTION ──────────────► walk folders,
        │                                "what apps live in here?"        read package.json
        │                                found: backend  = NestJS         files (skipping
        │                                       front_end = React          node_modules etc.)
        │                             3. save Project + create
        │                                a Snapshot (status:pending) ───► SQLite
        │   response: snapshot id     4. start the SCAN in the
        ◄──────────────────────────┤     background
        │
 redirected to /graph/<id>,
 polls "is it done yet?"              THE SCAN (takes ~4-6s):
        │                             ┌────────────────────────────┐
        │  GET /snapshots/<id>        │ NestJS extractor           │──► modules,
        ├──────────────────────────►  │ (backend controllers)      │    endpoints
        │   "running..."              ├────────────────────────────┤
        │                             │ Frontend extractor         │──► call sites
        │  GET /snapshots/<id>        │ (axios/fetch calls)        │
        ├──────────────────────────►  ├────────────────────────────┤
        │   "completed!"              │ Linker                     │──► call → endpoint
        │                             │ (match calls to endpoints) │    edges
        │  GET /snapshots/<id>/graph  └────────────────────────────┘
        ├──────────────────────────►  read everything back ───────────► SQLite
        ◄──────────────────────────┤
        │
 draw the graph 🎉
```

Two details worth understanding:

- **A "Snapshot" is one scan's result.** Every time you open/rescan a project,
  Vision creates a fresh snapshot rather than overwriting the old one. The
  graph page always shows one specific snapshot.

- **The scan runs in the background.** The engine answers "started!"
  immediately and the browser politely asks every ~0.8s whether it's finished
  (this is called *polling*). That's why you see a spinner that says
  "Analyzing project…".

- **`node_modules` is always skipped.** A project folder can contain 100,000+
  files of installed libraries. Vision only reads *your* source code
  (`node_modules`, `.next`, `dist`, `build` are hard-excluded), which is why a
  scan takes seconds, not minutes.

---

## 5. How Vision Reads Code Without Running It

This is the heart of the whole tool.

### Code is just structured text

When you look at code, you see text. A parser sees a **tree** — every file can
be broken down into nested pieces: "this is a class → it has a decorator → the
decorator has an argument → the argument is the string 'addresses'". That tree
is called an **AST (Abstract Syntax Tree)**. Vision uses a library called
**ts-morph** that builds this tree from TypeScript/JavaScript files and lets us
walk it and ask questions.

### A real example

This is real code from annpriya's backend
(`backend/src/addresses/addresses.controller.ts`):

```ts
@Controller('addresses')                 //  ← decorator: base path
@UseGuards(AuthGuard('jwt'))             //  ← decorator: login required (whole class)
export class AddressesController {

  @Patch(':id')                          //  ← decorator: PATCH method, subpath ':id'
  update(
    @Param('id') id: number,             //  ← path parameter
    @Body() dto: UpdateAddressDto,       //  ← the request body's shape
  ) { ... }
}
```

Those `@Word(...)` things are **decorators** — labels that NestJS itself uses
to wire up routes when the app runs. Vision reads the *same labels* directly
from the tree, without running anything:

```
  QUESTION VISION ASKS THE AST                          ANSWER
  ─────────────────────────────                         ──────
  Does this class have @Controller?                     yes → it declares endpoints
  What's the argument?                                  'addresses'   → base path
  Is there app.setGlobalPrefix(...) in main.ts?         'api'         → prefix everything
  Does this method have @Get/@Post/@Patch...?           @Patch(':id')
       ⇒ full path = /api + /addresses + /:id  =  PATCH /api/addresses/:id

  Any @UseGuards on the class or the method?            AuthGuard('jwt') → 🔒 login needed
  Any @Roles(...)?                                      (none here — but e.g. categories
                                                         has @Roles(Role.ADMIN))
  What type does @Body() have?                          UpdateAddressDto
       ⇒ follow the import to wherever that class
         lives, read its properties:
         address: string, latitude?: number, ...        → example JSON body for testing
```

Grouping into modules works the same way: every `*.module.ts` file has an
`@Module({ controllers: [AddressesController] })` decorator, so Vision knows
which controller belongs to which module — and that gives the graph its
categories.

### Why "static" is a superpower (and its one limit)

- ✅ The target project doesn't need to run, compile, or have its database up.
- ✅ It's fast (annpriya's 226 endpoints scan in ~4 seconds).
- ✅ It can't hurt anything — reading files changes nothing.
- ⚠️ Limit: Vision only knows what's *written literally* in the code. If a
  route path is built by complicated runtime logic, static analysis can only
  make its best guess. (This matters more for frontend calls — next section.)

---

## 6. Finding Frontend Calls & Linking the Two Worlds

A backend endpoint answers the phone. But *who calls it?* Vision also scans the
frontend (React) code for the places that make HTTP calls.

### What a frontend call looks like

annpriya's frontend has a services folder, where calls look like this:

```js
// front_end/src/services/api.js
const api = axios.create({
  baseURL: 'https://bookmyfresh.com/api',   // ← note the "/api" at the end!
});

// front_end/src/services/addressService.js
update: async (id, updates) => {
  const res = await api.patch(`/addresses/${id}`, updates);   // ← a call site
}
```

Vision finds every `api.get(...)`, `api.post(...)`, `fetch(...)` etc. and
extracts three things:

1. **The method** — `patch` → `PATCH`
2. **The URL** — `` `/addresses/${id}` ``. The `${id}` part is dynamic (unknown
   until runtime), so Vision replaces it with a wildcard: `/addresses/{}`
3. **The prefix** — the axios `baseURL` ends in `/api`, so the *real* path this
   call hits is `/api/addresses/{}`

### The matching game (the "linker")

Now Vision has two lists and plays a matching game:

```
   FRONTEND CALLS                              BACKEND ENDPOINTS
   ──────────────                              ─────────────────
   PATCH /api/addresses/{}          ──────►    PATCH /api/addresses/:id      ✓ MATCH
   GET   /api/addresses             ──────►    GET   /api/addresses          ✓ MATCH
   POST  /api/auth/send-otp         ──────►    POST  /api/auth/send-otp      ✓ MATCH

   Matching rule: same HTTP method + same number of path segments +
   each segment either identical, or a wildcard on either side:

        /api/addresses/{}            call     (3 segments)
        /api/addresses/:id           endpoint (3 segments)
         ───  ─────────  ──
          =        =     wildcard pairs with :id   →  it's a match
```

Every match becomes an **edge** (a connecting line) in the graph, with a
**confidence score**:

- exact literal match → high confidence (solid line)
- wildcards had to pair up → slightly lower
- one call matches *several* endpoints → confidence halved (dashed line),
  because Vision isn't sure which one is really being called

This is honest by design: static analysis of frontend URLs is a *very good
guess*, not a guarantee.

For annpriya: **198 call sites found, 198 linked.**

---

## 7. The Graph Screen Explained

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Vision  [Collections] [filter…]  24 modules · 226 endpoints  [Frontend]  │ ← toolbar
 │                                                    [env: local ▾] [+]    │
 ├──────────┬───────────────────────────────────────────────┬───────────────┤
 │          │                                               │               │
 │ COLLECT- │              THE CANVAS                       │  ENDPOINT     │
 │ IONS     │                                               │  PANEL        │
 │ SIDEBAR  │   ┌────────────┐      ┌──────────────────┐    │  (opens when  │
 │ (toggle) │   │ Addresses 6│─────►│GET /api/addresses🔒│   │  you click an │
 │          │   └────────────┘      ├──────────────────┤    │  endpoint)    │
 │ requests │        blue          │PATCH /api/addr../:id│  │               │
 │ +        │      = backend       └──────────▲───────┘    │  [Overview]   │
 │ scenarios│                                 ┆ dashed      │  [Test]       │
 │          │   ┌───────────────┐             ┆ = linked    │               │
 │          │   │addressService5│──►┌─────────┴────────┐    │               │
 │          │   └───────────────┘   │PATCH /addresses/{}│   │               │
 │          │        violet         └──────────────────┘    │               │
 │          │      = frontend                               │               │
 └──────────┴───────────────────────────────────────────────┴───────────────┘
```

- **Blue module nodes** = backend features (NestJS modules). The number is how
  many endpoints live inside. **Click to expand/collapse.**
- **Endpoint nodes** = the doors. Method badge (GET green, POST blue, PATCH
  amber, DELETE red), the full path, and a 🔒 if auth is required.
  **Click one → detail panel opens on the right.**
- **Violet nodes** = frontend files that make HTTP calls (e.g.
  `addressService`). Expand to see each call site.
- **Animated violet lines** = "this frontend call hits that backend endpoint."
  Dashed / faded = lower confidence. **Clicking a call node jumps you straight
  to its backend endpoint** — that's the fastest way to answer "what does this
  button actually call?"
- **Layout is automatic** — a library called dagre arranges nodes left-to-right
  so arrows flow frontend → backend. You can still drag anything anywhere.

The **detail panel** has two tabs:

- **Overview** — auth guards & roles, parameters, body fields (from the DTO),
  and the exact `file:line` where the endpoint is defined.
- **Test** — a ready-to-fire request. Next section.

---

## 8. Testing an API: Environments & the Runner

### Environments: "where is the app running, and who am I?"

The code says an endpoint's path is `/api/addresses` — but paths are relative.
Relative to *what*? That's what an **environment** answers:

```
  Environment "local"                Environment "staging"
  ────────────────────               ─────────────────────
  baseUrl: http://localhost:8001     baseUrl: https://staging.example.com
  token:   eyJhbG...(JWT)            token:   eyJhbG...(different JWT)
  variables: { }                     variables: { }
```

You pick the active environment in the toolbar. The same saved request can then
be fired at local, staging, or prod just by switching environments.

Environments also hold **variables**. Anywhere in a URL, header, or body you
can write `{{name}}` and it gets replaced at send time. Two variables are
always auto-filled: `{{baseUrl}}` and `{{token}}`.

### What happens when you press Send

```
  BROWSER                    ENGINE                              TARGET APP
  ────────                   ───────                             (e.g. annpriya
     │                                                            on :8001)
     │ "PATCH /api/addresses/42
     │  body {...} using env=local"
     ├────────────────────────►
     │                        1. look up env "local"
     │                        2. replace {{variables}}
     │                        3. glue baseUrl + path:
     │                           http://localhost:8001/api/addresses/42
     │                        4. add header:
     │                           Authorization: Bearer <token>
     │                        5. actually send it ──────────────────►
     │                                                               (handles it)
     │                        6. receive: status, headers, body ◄────
     │                        7. save the whole exchange
     │                           to history (SQLite),
     │                           token redacted
     │  ◄────────────────────┤
     │  show: 200 OK · 38ms
     │  + pretty-printed JSON
```

Notice **the browser never touches the target app** — that's the CORS/token
story from section 2 in action.

The **Test tab pre-fills everything it can**: path parameter boxes come from
the parsed route, and the JSON body skeleton comes from the parsed DTO (string
fields become `""`, numbers become `0`, and so on). You fill in real values and
press Send. Every run lands in a per-endpoint **history** list.

---

## 9. Collections & Assertions

### Collections = your saved request library

After crafting a request in the Test tab once, press **Save** and put it in a
collection (a named folder, e.g. "auth flows", "smoke tests"). Saved requests
live in the left sidebar and can be re-run with one click — no re-typing.

### Assertions = automatic pass/fail checks

A saved request can carry **assertions**: rules checked against the response
every time it runs. Four types exist:

| Type           | Checks…                        | Example                              |
|----------------|--------------------------------|--------------------------------------|
| `status`       | the HTTP status code           | status `eq 200`                      |
| `jsonPath`     | a value inside the JSON body   | `data.user.role eq ADMIN`            |
| `header`       | a response header              | `content-type contains json`         |
| `responseTime` | how long the request took (ms) | responseTime `lt 500`                |

`jsonPath` uses simple **dot paths** to dig into JSON:

```json
response body:  { "data": { "items": [ { "id": 7 } ] } }

dot path:         data.items[0].id      →  7
```

Operators: `eq`, `neq` (not equal), `lt` / `gt` (less/greater than),
`contains`, `exists`.

When you run the request, each assertion shows ✓ or ✗ with the actual value it
found — so a saved request with assertions is effectively a **mini automated
test**.

---

## 10. Scenarios: Chaining Requests Together

Real testing usually needs *sequences*: log in first, *then* use the token.
That's what scenarios are.

A **scenario** is an ordered list of saved requests. The magic is
**extraction**: after each step, you can pull values out of the response and
save them as variables for the *next* steps.

```
  SCENARIO: "place an order"                        runtime variables
  ══════════════════════════                        ═════════════════
                                                    (starts empty)
  step 1: POST /api/auth/verify-otp
          response: { "accessToken": "eyJh..." }
          extract:  token ← accessToken       ────► { token: "eyJh..." }
                │
                ▼
  step 2: POST /api/cart   (header uses {{token}})
          response: { "cart": { "id": 512 } }
          extract:  cartId ← cart.id          ────► { token: "...", cartId: "512" }
                │
                ▼
  step 3: POST /api/orders
          body: { "cartId": {{cartId}} }      ◄──── both variables substituted
          assertions: status eq 201
```

Rules of the chain:

- Steps run **in order**, one at a time.
- Extracted variables **override** environment variables with the same name.
- If a step **fails** (network error, HTTP 4xx/5xx, or any assertion fails),
  the remaining steps are **skipped** and the scenario reports FAILED.
- Every step's result — status, extracted values, assertion ✓/✗ — is shown in
  the sidebar after the run.

---

## 11. Where Everything Is Stored

Vision keeps everything in **one small database file** on your machine:
`apps/engine/prisma/dev.db` (SQLite — a database that lives in a single file,
no server needed). The engine talks to it through **Prisma**, a library that
turns TypeScript calls into SQL.

Two families of tables:

```
  SCAN RESULTS (rebuilt every scan)          YOUR TEST DATA (permanent)
  ─────────────────────────────────          ──────────────────────────
  Project        "annpriya", its path        Environment   baseUrl + token + vars
    └─ Snapshot  one scan's result             Collection    a folder of…
        ├─ ModuleNode   the categories           └─ SavedRequest  …reusable requests
        │    └─ Endpoint  the doors                   └─ Assertion   pass/fail rules
        ├─ FrontendCall  call sites            Scenario
        └─ GraphEdge     call→endpoint links     └─ ScenarioStep  ordered, w/ extractions
                                               Execution     history of every run
```

The separation matters: rescanning a project creates a *new snapshot* (fresh
scan-results rows) but never touches your environments, collections, or
history.

---

## 12. Folder Map of This Repo

```
vision/
├─ apps/
│  ├─ web/                        ← what you see (Next.js, port 3000)
│  │  ├─ app/page.tsx             ← home: open a project
│  │  ├─ app/graph/[snapshotId]/  ← the graph page
│  │  ├─ components/
│  │  │  ├─ GraphView.tsx         ← the canvas: nodes, edges, layout, toolbar
│  │  │  ├─ graph-nodes.tsx       ← how module/endpoint/call nodes look
│  │  │  ├─ EndpointPanel.tsx     ← right panel (Overview + Test tabs)
│  │  │  ├─ TestPane.tsx          ← the request builder
│  │  │  ├─ CollectionsPane.tsx   ← saved requests + assertions editor
│  │  │  ├─ ScenariosPane.tsx     ← chains + step results
│  │  │  └─ EnvPicker.tsx         ← environment dropdown in the toolbar
│  │  └─ lib/api.ts               ← every call the browser makes to the engine
│  │
│  └─ engine/                     ← the worker (NestJS, port 4000)
│     ├─ prisma/schema.prisma     ← database table definitions
│     └─ src/
│        ├─ projects/             ← "open a project" endpoint
│        ├─ analysis/
│        │  ├─ stack-detector.service.ts    ← "what apps are in this folder?"
│        │  ├─ nest-extractor.service.ts    ← reads backend controllers  (§5)
│        │  ├─ frontend-extractor.service.ts← finds axios/fetch calls    (§6)
│        │  ├─ next-extractor.service.ts    ← reads Next.js API routes
│        │  ├─ linker.ts                    ← the matching game          (§6)
│        │  └─ scanner.service.ts           ← runs all of the above, saves results
│        ├─ runner/
│        │  ├─ runner.service.ts            ← sends real requests        (§8)
│        │  └─ assertion-evaluator.ts       ← checks assertions          (§9)
│        ├─ environments/                   ← environment CRUD
│        ├─ collections/                    ← collections & saved requests
│        └─ scenarios/                      ← chains & the step-runner   (§10)
│
├─ packages/shared/src/index.d.ts ← the type "dictionary" both apps use (§2)
└─ docs/HOW-IT-WORKS.md           ← you are here
```

**To run it:** `pnpm dev` at the repo root starts both apps. Web = 3000,
engine = 4000.

---

## 13. Glossary

| Term | Plain-English meaning |
|---|---|
| **API / endpoint** | A "door" into a server: an HTTP method + a path, e.g. `GET /api/users` |
| **AST** | The tree-shaped version of source code that parsers work with |
| **Static analysis** | Reading & understanding code **without running it** |
| **Decorator** | A `@Label(...)` above a class/method; NestJS uses them to declare routes, guards, etc. |
| **DTO** | A class describing the shape of data an endpoint accepts |
| **Guard** | An auth rule on an endpoint ("must be logged in", "must be ADMIN") |
| **Module (NestJS)** | A feature folder of backend code; a category node in the graph |
| **Snapshot** | The saved result of one scan of a project |
| **Edge** | A line in the graph; `contains` (module→endpoint) or `calls` (frontend→backend) |
| **Confidence** | How sure the linker is that a call really hits that endpoint (1.0 = sure) |
| **Environment** | A named target: base URL + token + variables (local / staging / prod) |
| **`{{variable}}`** | A placeholder replaced at send time from the environment or earlier scenario steps |
| **Assertion** | An automatic pass/fail check on a response |
| **Scenario** | An ordered chain of saved requests with value extraction between steps |
| **Polling** | Repeatedly asking "done yet?" — how the browser waits for a scan |
| **CORS** | Browser rule blocking cross-site requests — the reason the engine sends test requests, not the browser |
| **SQLite / Prisma** | The single-file database Vision stores everything in / the library used to talk to it |
| **ts-morph** | The library that parses TypeScript/JavaScript into an AST for us |
| **dagre** | The library that auto-arranges graph nodes so the layout looks sane |
