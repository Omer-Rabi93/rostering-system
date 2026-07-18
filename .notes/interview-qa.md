# Rostering System — Interview Q&A Prep

Questions you're likely to be asked about this project, with answers grounded in what the code
actually does. Each answer leads with the "why" — that's what interviewers probe.

---

## 1. The elevator pitch

**Q: Describe the system in 30 seconds.**

A workforce rostering system for a 24/7 security operation with three fixed daily shifts (A/B/C,
8 hours each). Each company manages its workers, contracts, and per-date availability; a
constraint-solver engine (Google OR-Tools CP-SAT) auto-generates a monthly roster that respects
availability, role coverage requirements, min/max contracted hours, and a hard 2-shifts-per-day
cap. Planners can manually edit the roster (validated server-side), must acknowledge alerts before
publishing, and get a cost dashboard. Workers see their schedule through a read-only tokenized
link — no worker accounts. Architecture: React SPA + Express/TypeScript API + PostgreSQL, with a
Python solver sidecar and a pg-boss background-job worker, all behind one nginx origin in Docker.

**Q: What was the core problem being solved?**

Manual spreadsheet scheduling caused under-staffed shifts and contract violations. The core of the
product is **auto-assignment**: given availability and contracts, produce a valid roster and
surface risk (unfillable slots, min-hours shortfalls) *before* saving, instead of discovering it
during the month.

---

## 2. Stack choices — "why did you pick X?"

**Q: Why Node.js + TypeScript + Express for the API?**

One language and one type system across the API, the validation engine, the background jobs, and
the UI — the Zod schemas that validate requests are the same source the frontend types come from,
so contracts can't drift. Express is deliberately thin: routes just parse (Zod) → call a service →
respond. The design weight lives in the service layer and the pure `engine/` module, not the
framework. Express 4 specifically because it's the stable, battle-tested line (v5 was still
settling); nothing in the app needs more than routing + middleware.

**Q: Why not NestJS / Fastify?**

The app doesn't need a framework's DI container or decorators — the architecture already enforces
separation (routes / services / pure engine) with plain modules, and that's easier to test and
reason about. Fastify's throughput advantage is irrelevant here: the expensive work (CSV import,
solving) is off the request path in background jobs anyway.

**Q: Why PostgreSQL + Prisma?**

Postgres because the domain is relational and the design leans hard on **database-enforced
invariants**: unique national ID, one contract per worker, one roster per (company, month), one
shift row per calendar slot, and a composite PK on `shift_workers` so a worker can never occupy
the same slot twice — even under concurrent edits. Prisma gives schema-first migrations so those
constraints are declared once in `schema.prisma`. Where Prisma's DSL falls short we drop to raw
SQL in migrations: the case-insensitive unique index on `companies(lower(name))` and the
**partial unique index** on `import_tasks(companyId, kind) WHERE status IN
('PENDING','PROCESSING')`. Postgres also carries the job queue (pg-boss), so one database serves
data + queue + cron.

**Q: Why Zod?**

Runtime validation at every trust boundary with **inferred TypeScript types** — validation and
types come from the same declaration, so they can't diverge. It's used in three distinct places:
(1) every API request body/param, mapped to a uniform 400 envelope by the central error handler;
(2) domain rules like the Israeli-ID checksum; (3) validating the **solver's stdout** — the Python
process's output is treated as untrusted input and parsed with a `.strict()` discriminated-union
schema before anything is persisted.

**Q: Why a pnpm + Turborepo monorepo?**

Four workspaces (`apps/api`, `apps/web`, `packages/shared`, `packages/ui`) that genuinely share
code — the shared Zod schemas and the UI kit. pnpm gives cheap, correct workspace linking;
Turborepo gives topological ordering (`lint`/`typecheck`/`test` all depend on `^build`, so
`shared` builds before `api`) plus content-addressed caching. `turbo prune --docker` is also the
linchpin of the Docker builds — each image gets a minimal, cacheable subset of the monorepo.

**Q: Why does `packages/shared` ship compiled `dist` instead of raw source?**

It makes the package consumable identically by every environment — Node API, worker process,
Docker images, E2E setup — without each consumer needing to compile someone else's TypeScript.
One pragmatic exception: the web app's Vite config aliases `@rostering/shared` to source for
faster dev iteration; runtime (Docker, tests, dev API) resolves the built `dist`.

**Q: Why React + Vite, and why Redux Toolkit / RTK Query?**

Vite for fast SPA tooling. RTK Query because the app is dominated by server state with precise
cache-invalidation needs: tags are **scoped** (e.g. `{type:'Availability', id: month}`) so saving
one month's availability doesn't refetch every cached month, and job completion drives
invalidation (a finished `roster-generation` job invalidates `Roster` + `CostSummary`). Client-only
UI state (active company, dialogs, roster editor) lives in small plain slices.

---

## 3. The scheduling engine (expect the deepest questions here)

**Q: Why a constraint solver (CP-SAT) instead of a greedy algorithm?**

Greedy fills slot-by-slot with heuristic tie-breaks and can't see the whole-month interplay: it
can happily give a worker hours early in the month and then be unable to satisfy someone else's
minimum later. CP-SAT optimizes the **entire month in one model**, handling coverage, min/max
hours, and fairness simultaneously and globally optimally. The trade-off — solver runtime and a
Python dependency — is absorbed by the async job worker, where a few seconds of solving is
invisible to the API.

**Q: Why Python? You said everything is TypeScript.**

OR-Tools has no official Node binding. So the solver is a small (~250-line) Python script invoked
per generation job: JSON in on stdin, JSON out on stdout. That keeps the entire rest of the
codebase pure TypeScript and keeps the sidecar trivially replaceable — it's a wire contract, not a
library dependency.

**Q: Walk me through the model.**

- **Decision variables:** booleans `x[worker, date, shift]`, created **only** where the worker has
  an availability row for that exact date containing that shift — this prunes the model before
  solving starts; a worker with no availability contributes zero variables.
- **Hard constraints:** (a) per (date, shift, role): sum of assigned workers **plus a shortfall
  slack** equals the required headcount; (b) ≤ 2 shifts per worker per calendar day; (c)
  `8·Σx ≤ maxMonthlyHours`.
- **Soft constraints as slacks:** coverage shortfall slack per slot, and per-worker min-hours
  deficit (`8·Σx + deficit ≥ minMonthlyHours`).
- **Objective (lexicographic via weights):** `minimize(10000·Σshortfall + 100·Σdeficit +
  1·(load_max − load_min))` — coverage first, then min-hours, then fairness. Fairness is each
  worker's hours as a percentage of *their own* max hours, minimizing the spread between the most-
  and least-loaded worker.

**Q: What happens when the roster is infeasible?**

It never is — **by construction**. Every shortage is absorbed by a slack variable, so the solver
always returns the best possible roster *plus alerts*: each positive coverage slack becomes an
`unfillable_slot` alert, each positive deficit a `min_hours_shortfall` alert. The planner must
explicitly acknowledge every alert before the roster can be published. This turns "solver error"
into a product feature (staffing-risk surfacing), which was a PRD requirement.

**Q: How do you guarantee determinism?**

Fixed `random_seed=42`, `num_search_workers=1` (multi-threaded search is nondeterministic), a 30s
time limit with best-feasible accepted, and **explicitly sorted output** (assignments and alerts)
so nothing depends on dict iteration order. There's a pytest that runs the solver twice as a real
subprocess and asserts **byte-identical** stdout. Determinism matters because "generate twice,
same input, same roster" is both testable and explainable to a planner.

**Q: How does Node talk to the Python process? Any security concerns?**

`spawn(python, [scriptPath], {shell: false})` — a fixed two-element argv of build-time constants.
The problem JSON travels **only over stdin** — never argv, never env — so no user-derived value
can ever reach a shell string or command line (no injection surface). Non-zero exit → typed
`SolverProcessError` carrying stderr; exit 0 → stdout parsed by a strict Zod schema before
anything is trusted. Node enforces its own 35s kill timeout, deliberately just above the solver's
internal 30s cap so the Python side gets to fail cleanly first. There's even a contract test where
an env flag makes the solver emit garbage, proving the Zod layer rejects malformed output.

**Q: Do manual edits go through the solver?**

No — manual edits go through a pure TypeScript `RosterValidator` that mirrors the solver's
constraints. **Hard rules** (third shift in a day, outside availability for that exact date, role
mismatch, inactive worker, duplicate slot) are rejected with 422 and can never be persisted or
overridden. **Soft rules** (exceeding max hours, dropping below min) return 409 with warnings; the
client re-sends the identical request with `?confirm=true`. The confirm flow is stateless, and the
server re-checks hard rules regardless of the flag — `confirm` can never override a 422. One
subtle rule: removals are always allowed even for deactivated workers, so a stale assignment never
becomes unremovable.

**Q: Why is `engine/` "framework-pure"?**

`apps/api/src/engine/**` may not import Express, Prisma, or pg-boss — enforced by an ESLint
`no-restricted-imports` rule, not just convention. Pure functions over plain data means the API,
the background worker, and unit tests all call *identical* code, and the validator/problem-builder
are testable with no infrastructure. It's a hexagonal-architecture core without the ceremony.

---

## 4. Background jobs

**Q: Why are CSV import and roster generation asynchronous?**

Neither belongs in an HTTP request: a large CSV or a 30s solve would tie up a request worker and
time out at the proxy. The API validates cheaply (headers, row cap, month shape), enqueues, and
returns `202 {jobId}`; a **separate worker process** executes the job; the UI polls
`GET /api/jobs/:id` every 1.5s until a terminal state. The API process never calls
`boss.work()` — send-only — so HTTP capacity and job execution scale independently.

**Q: Why pg-boss instead of Redis + BullMQ (or SQS, RabbitMQ…)?**

**Zero extra infrastructure.** pg-boss is a Postgres-backed queue that claims jobs with
`SELECT … FOR UPDATE SKIP LOCKED`, and it also supplies the two other primitives the design needs:
**cron scheduling** (auto-generate next month's draft on the 25th) and **singleton keys** (at most
one in-flight generation per company+month). At this scale the DB queue is nowhere near a
bottleneck, and one fewer stateful service means simpler ops, simpler local dev, simpler compose
file. If throughput ever demanded it, the queue sits behind a small interface so swapping in Redis
is an implementation detail.

**Q: Why polling instead of WebSockets?**

Deliberate scope decision: the only async results are job completions, polling every 1.5s is
plenty responsive for a planner-facing tool, and it removes a whole class of infrastructure
(sticky sessions / pub-sub across API replicas — remember the API runs scaled to 2+ behind nginx).
Polling also composes trivially with RTK Query and stops itself on terminal states.

**Q: How do you prevent two roster generations for the same month running at once?**

pg-boss `singletonKey = "companyId:month"` with the **`stately` queue policy** — stately's DB
uniqueness constraint blocks a second job while an existing one is in *any* non-terminal state
(created or active), not just the same state. A blocked send returns `null` → the API responds
409 `generation-in-progress`. Gotcha we hit: the key is *required*, because stately's uniqueness
index coalesces a missing key to `''` — a keyless job would make the whole queue globally
single-flight across all companies.

**Q: "Uploading again cancels the old import" — how does that work?**

Cancel-and-replace per (company, kind): the route cancels any non-terminal `ImportTask` (and its
pg-boss job), creates a fresh PENDING task, then enqueues. Three hardening layers, each earned:

1. **DB backstop:** a partial unique index allows at most one non-terminal task per
   (company, kind) — careful app-level ordering alone loses races between near-simultaneous
   uploads.
2. **Retry loop:** the whole cancel-then-create-then-enqueue sequence retries (up to 5×) on either
   a unique-constraint violation or a lost pg-boss singleton slot — a single attempt was proven
   insufficient by a rapid-fire re-upload load test.
3. **Cooperative cancellation:** `boss.cancel()` can't interrupt a handler that's already running,
   so the row-processing loop periodically re-reads its own task status and stops if it's been
   cancelled.

**Q: What about retries and idempotency?**

Both handlers run with `retryLimit: 2` **because they're idempotent**: import upserts by national
ID, and generation deletes-and-rewrites the month's draft shifts + alerts inside one transaction —
a retried job converges on the same state. Retry policy is only safe because idempotency was
designed first; I'd make that point in that order.

**Q: How is worker concurrency tuned?**

By workload shape, env-configurable: CSV queues are I/O-bound → concurrency 8, sized to stay under
the Prisma pool of 10; roster generation is CPU-bound (each solve is a single-threaded Python
process, single-threaded *for determinism*) → concurrency 2. It was originally hardcoded to 1,
which serialized all companies system-wide — a real bug we fixed. pg-boss and Prisma each get
their own explicit connection-pool caps so the two can't starve each other.

---

## 5. Data modeling — the decisions and their stories

**Q: Tell me about a design decision you had to reverse.** *(Great story — use it.)*

Availability. v1 modeled it as a weekly recurring pattern — a 7-weekday × 3-shift boolean matrix
on the Contract. Re-reading the source requirements with the stakeholder showed that's wrong:
planners enter availability **per real calendar date** for the month being rostered ("March 3rd:
mornings only"), not "every Sunday". So we replaced it with a `WorkerAvailability` table — one row
per (worker, exact date) with a canonical shift-subset string, `@@unique([workerId, date])`,
**absence of a row = unavailable, no fallback**. That touched the schema, the solver's variable
creation, the validator, the API, and the CSV format (the worker CSV dropped 21 `avail_*` columns;
a separate month-scoped availability CSV was added). Lesson: validate the domain model against how
users actually work before building on it — and when it's wrong, replace it fully rather than
layering compatibility on top.

**Q: Why is "absent row = unavailable" instead of a default?**

It makes the safe state the default state — nobody gets scheduled on a date nobody entered. It
also maps cleanly onto the strict TypeScript config: `noUncheckedIndexedAccess` forces every
lookup to handle `undefined`, and here `undefined` *is meaningful* (unavailable), so the type
system pushes you toward correct handling instead of `!` assertions. (Roadmap note: there's a
planned inversion to exclusion semantics — a row lists shifts a worker *can't* work, absence =
fully available — chosen so "fully unavailable" stays representable as a normal row.)

**Q: Why does `ShiftWorker` snapshot the worker's role?**

Historical accuracy: if a worker is later promoted (Guard → Supervisor), an already-generated
roster must still show what role they were assigned *as*. Cost/hour totals are never stored —
always computed as `count × 8 × hourly rate` at read time — so totals can't drift from the
assignments.

**Q: How is the shifts/assignments relationship modeled?**

Normalized: `Roster (1 per company+month) → Shift (unique per roster+date+shiftType, created at
generation) → ShiftWorker (junction, PK = shiftId+workerId)`. The composite PK makes "same worker
twice in one slot" impossible at the database level, even under concurrent edits — the invariant
doesn't depend on application code being right.

**Q: What's your cascade/restrict strategy?**

Cascade where a child has no meaning without its parent (roster → shifts → shift_workers, roster →
alerts — regenerating a draft wipes cleanly in one delete; worker → availability). **Restrict**
where deletion would destroy history: a company with workers can't be deleted, and a worker with
shift history can't be deleted — the API turns that into "deactivate instead" (409 with guidance).
Inactive workers keep contract, token, and history; they're just filtered from every candidate
query.

**Q: How did multi-company support evolve?** *(Another good evolution story.)*

Three stages. (1) Company started as pure employer grouping — rostering was global. (2) Then
requirements shifted: rosters, staffing requirements, and imports became per-company
(`@@unique([companyId, month])` on Roster). (3) The UI initially exposed that as three
copy-pasted per-page dropdowns — bad UX — replaced by a global "active company" context: chosen
once behind a gate, persisted in localStorage, provided by a React context whose hook returns a
guaranteed non-null id, which deleted all the per-page "no company selected" boilerplate.

**Q: The CSV import used to deactivate absent workers. Why did that change?**

The original "import = full sync" swept **globally**: uploading Company A's file deactivated every
worker of every other company not in that file — a real cross-company bug once multi-company
arrived. The fix replaced the destructive sweep with **presence tracking**: each worker row is
stamped with the `ImportTask` id that last touched it; roster generation only considers workers
whose stamp matches the company's latest completed sync (or who were never CSV-managed at all —
`null` stamp means "manually managed, always eligible"). A worker absent from the latest file
stays ACTIVE but becomes ineligible until they reappear. Absence from a file now means "not
rosterable" instead of "silently deactivated" — same intent, no destructive side effect, and
scoped per company.

---

## 6. CSV pipeline

**Q: Why a real CSV library instead of splitting on commas?**

`csv-parse` is a real tokenizer — `split(',')` breaks the moment a worker's name contains a comma.
Row width is still validated manually so we can distinguish a malformed row (per-row error) from a
malformed file (400 before enqueue).

**Q: How do you handle a bad row?**

Per-row error reporting, never abort-the-batch: each row is processed in its own transaction, so a
failing row rolls back only itself; the job result carries a report (`inserted / updated / failed`
+ per-row errors with row numbers). Cheap structural checks (headers exactly matching the target
month's day count, `MAX_ROWS = 10,000` cap) run **before** enqueue so garbage never reaches the
queue.

**Q: Any CSV security considerations?**

- **Formula injection**: every exported cell goes through a guard for `=`, `+`, `-`, `@` prefixes
  (and is unguarded on import) — defense-in-depth even for columns that are constrained to digits.
- **Upload limits**: multer with memory storage (no disk spool), 2MB file cap, single file,
  extension + MIME allowlist — one shared config so the two upload routes can't drift.
- **PII**: national IDs are redacted (last-4) in server logs; full IDs appear only in
  planner-facing API results.

**Q: Why is the Israeli ID validated with a checksum?**

Teudat Zehut has a Luhn-like check digit (alternating 1/2 weights, digit-sum, mod 10). Validating
it catches typos at data entry — in a system keyed on national ID (it's the CSV upsert key), a
mistyped ID would otherwise silently create a duplicate person.

**Q: Why two separate CSV formats (workers vs availability)?**

Different scopes and different absence semantics. The worker CSV is a whole-workforce sync where
absence has consequences (ineligibility); the availability CSV is month-scoped where absence means
"leave that worker's month untouched". One combined format would force a single file to serve two
contradictory "what does an absent row mean" rules.

---

## 7. API design

**Q: Explain your error-handling conventions.**

Typed error classes thrown from services (which are Express-free), mapped by one central error
handler mounted last: 400 Zod validation (`{errors:[{path,message}]}`), 404 unknown resource,
**422 hard-rule violation** (never persisted, no override), **409** for both state conflicts and
soft-rule warnings (`{warnings, confirmRequired:true}`). Unexpected errors are logged server-side
(with ID redaction) and surface as a generic 500 — Prisma internals and stack traces never leak to
the client.

**Q: Why 422 vs 409 for the two rule classes?**

They're semantically different verdicts. 422 = "this edit is invalid and no flag will make it
valid" (a third shift that day). 409 + `confirmRequired` = "valid but has consequences — confirm."
The client resubmits the *identical* request with `?confirm=true`; the server holds no dialog
state, and hard rules are re-checked regardless of the flag.

**Q: Where's the authentication?**

Deliberately out of scope, and documented as such: single-operator, trusted deployment — a
planner-facing internal tool. The one access-control mechanism is the public schedule link: a
non-guessable per-worker UUID token, rotatable, rate-limited (30 req/min/IP at both nginx and
Express), returning only published rosters and only that worker's data, with 404 indistinguishable
between "bad token" and "no data". If it were exposed to untrusted parties I'd add an auth layer
(sessions or OIDC), role-based permissions, and an audit trail — the single-user model is why
those were cut, and the schema leaves room for them.

**Q: Any interesting routing bug?**

Yes — the public schedule page. The SPA route and the API endpoint were originally the same
literal path, `/schedule/:token`; nginx couldn't distinguish a browser navigation from a data
fetch. Fix: the data endpoint lives at `/api/schedule/:token`, the SPA owns `/schedule/:token`.
Related lesson in body limits: the global JSON limit is 100kb, but a dense month-of-availability
PUT can exceed that (~1KB/worker × hundreds of workers), so that one router mounts *before* the
global parser with its own 2MB limit — Express router mount order is what makes route-scoped
limits work.

---

## 8. Frontend

**Q: How does the UI know when a background job finishes?**

A `useJobPolling` hook over RTK Query: poll `GET /api/jobs/:id` at 1.5s, stop by dropping the
polling interval to 0 on terminal states. On completion it dispatches tag invalidation — a
finished generation invalidates `Roster` + `CostSummary`, a finished import invalidates `Worker` —
so the relevant screens refetch automatically. Cache tags are month-scoped to avoid refetching
unrelated months.

**Q: Anything notable about the public schedule page?**

It's architecturally isolated: it uses raw `fetch`, not RTK Query, and imports nothing from the
Redux store — enforced by a dedicated architecture test — so the unauthenticated token page has
zero import-graph reachability into planner state. It also ships a print stylesheet, since
"printout on the guard-room wall" is a real use case.

**Q: What did you do for accessibility?**

The calendar and availability grids use a **roving tabindex** pattern (one tab stop per grid,
arrow-key navigation, `aria-label` per cell describing worker/date/shifts) — extracted into a
shared `useRovingTabindex` hook so both grids share one tested implementation. Focus traps in
modals, `aria-live` job progress, axe audits in the E2E suite with WCAG-AA contrast fixes baked
into the design tokens (light and dark).

---

## 9. Infra & deployment

**Q: Walk me through the production topology.**

One `docker compose up`: nginx (the only published port, :80) serves the built SPA and reverse-
proxies `/api` to the Express service; Postgres is internal-only; a separate worker container runs
pg-boss handlers and carries the Python/OR-Tools runtime; a one-shot `migrate` service runs
`prisma migrate deploy` before api/worker start (`depends_on: service_completed_successfully`), so
migrations apply exactly once per deployment before anything queries the schema.

**Q: Why serve SPA and API from one origin?**

It deletes entire problem classes: no CORS configuration, CSP stays `default-src 'self'`, one port
to expose, and cookies/headers would behave simply if auth were added later. nginx routes by path:
`/api` → proxy, everything else → `try_files … /index.html` for the SPA's history-mode router.

**Q: How does API scaling work?**

The API is stateless (state lives in Postgres, including the queue), so `docker compose up
--scale api=2` works with zero config changes: Docker's embedded DNS returns multiple A records
for the service name, and nginx's `least_conn` upstream balances across them. The rate-limit zone
for the public endpoint also lives at nginx, so it's enforced consistently across replicas.

**Q: Why is the worker a separate container from the API?**

Different workload, different runtime, different scaling. The worker needs Python + OR-Tools
baked in (a venv built at image-build time — nothing installed at runtime); the API image doesn't
carry Python at all. CPU-heavy solving can't degrade HTTP latency, and worker replicas can scale
independently — safe because pg-boss's row-claiming (`SKIP LOCKED`) makes multiple consumers
correct by construction. The worker has no HTTP port, hence no healthcheck — liveness is just
restart policy; its "heartbeat" is consuming jobs from Postgres.

**Q: Anything clever in the Dockerfiles?**

All three are multi-stage builds on `turbo prune --docker`: prune emits a lockfile-only layer
(cacheable `pnpm install`) plus the minimal source subset for that app, so an api-only change
doesn't bust the web image's cache and images stay small. Runtime stages are non-root. The
`migrate` service reuses the api Dockerfile's *builder* stage — the only stage with the Prisma CLI
and migrations — rather than shipping migration tooling in the runtime image.

---

## 10. Testing strategy

**Q: What's your testing philosophy here?**

Test against the real thing wherever the real thing is cheap. API integration tests run against a
**real dockerized Postgres** — never a mocked Prisma — because the design puts invariants *in* the
database (unique/partial indexes, cascades); mocking the DB would test the mock. The suite
truncates and reseeds between tests (table discovery is dynamic, so it stays correct as the schema
grows), and file parallelism is off because parallel files racing one shared DB is real flakiness,
not noise. Development is TDD in vertical slices (red→green per feature slice, backend and
frontend page logic alike).

**Q: How do you test the Python solver?**

Two levels. In-process pytest per constraint family: coverage shortfall, the 2-shifts/day cap
(including "shift C then next-day shift A is legal — the cap is per calendar day"), min-hours
deficit values, fairness spread. Then subprocess tests of the real stdin→stdout contract,
including **byte-identical determinism across two runs** and a timeout test that starves a big
problem (time limit 1ms) and asserts a clean exit-1 with a message instead of a crash. On the Node
side a contract test spawns the actual script; an env-var escape hatch makes it emit garbage
output to prove the Zod parsing layer rejects it.

**Q: And end-to-end?**

Playwright across chromium/firefox/webkit, running the real dev servers, real migrations, real
pg-boss worker, real Python solver — nothing mocked except the nginx layer (covered by a compose
smoke test). The E2E suite gets its **own throwaway Postgres on port 5439**, isolated from dev and
prod databases, recreated fresh each run. It runs serially (`workers: 1`) because all specs share
that one DB — a deliberate correctness-over-speed call; the bottleneck is solver/DOM latency, not
CPU. Suites cover the golden path plus keyboard-only operation, axe accessibility, and resilience.

**Q: Did testing ever change the design?**

Yes — the load-test suite did. A rapid-fire re-upload script proved that the app-level
cancel-and-replace sequence loses races under concurrent uploads, which is what forced the partial
unique index + retry loop design. Same suite motivated the concurrency split (I/O-bound vs
CPU-bound queues) and proved companies no longer block each other.

---

## 11. Hard/critical questions — own the trade-offs

**Q: What are the system's main limitations?**

Be upfront: (1) **No auth** — fine for the trusted single-operator deployment it's specified for,
first thing to add before wider exposure. (2) **Polling, not push** — chosen simplicity; fine at
this scale. (3) **Full-month regeneration only** — partial/range regeneration is designed but not
built (see next). (4) Solver capped at 30s best-effort — for enormous problems you'd get a good,
not provably optimal, roster (still valid, still alerted).

**Q: How would you do partial roster regeneration ("just redo next week")?**

The persistence side is easy (range-scoped delete/rebuild). The hard part is the solver: monthly
constraints (max hours, fairness, the daily cap) span the whole month, so you can't just solve a
sub-range — a worker might already hold 190 of their 200 max hours in fixed, out-of-range days.
The design: pass existing out-of-range assignments into the model as **fixed constants** that
count toward every accumulation constraint, and create decision variables only for in-range slots.
It's sketched in the roadmap; it was deliberately deferred because it touches the highest-risk,
determinism-sensitive component and deserves its own verification cycle.

**Q: What breaks first at 10× scale?**

Honest answer: nothing structural for a long time. The model working set for one company-month
(hundreds of workers × 31 days × 3 shifts) fits comfortably in memory and in CP-SAT. Pressure
points in order: solver wall-time on very large months (mitigations: raise the time limit, more
worker replicas since each solve is single-threaded, eventually decompose the model); Postgres as
combined queue+data store (swap pg-boss for a dedicated queue behind the existing interface);
polling fan-out (move to SSE/WebSockets). The stateless-API + queue-backed-worker shape is exactly
what makes each of those a local change.

**Q: What would you do differently starting over?**

- Nail the availability domain model with the stakeholder *before* building v1 — the weekly-matrix
  rework was the most expensive correction.
- Scope everything by company from day one — retrofitting company scoping exposed the
  cross-company deactivation bug and drove several revision cycles.
- Possibly add a thin auth layer earlier even for a "trusted" deployment — cheap at the start,
  expensive later.

**Q: Where do you enforce invariants — app or database?**

Both, deliberately layered: everything the database *can* express is a constraint (uniques,
composite PKs, partial unique index, cascades/restricts) so it holds even under concurrency or
buggy code; cross-row rules the DB can't express (2-shifts-per-day, availability) live in one
shared validator used by every write path. The principle: an invariant enforced in exactly one
place, at the lowest layer capable of expressing it.

**Q: Race conditions you actually dealt with?**

Three good ones: (1) concurrent same-company uploads both cancelling the same task and both
creating a new one — fixed with the partial unique index + retry; (2) the pg-boss singleton slot
vs the ImportTask row being two independently-raced resources — the enqueue sequence retries on
losing either; (3) `boss.cancel()` being unable to stop an in-flight handler — cooperative
cancellation inside the row loop. Also the keyless-singleton gotcha (missing key = global
single-flight) which we reproduced deliberately before relying on the fix.

---

## 12. Head-to-head: "why this tool and not that one?"

The pattern for answering ANY "why not X" question: (1) name the requirement that drove the
choice, (2) name what the chosen tool uniquely provided *for this project*, (3) concede the
alternative's real strength honestly, (4) show the exit is cheap if you turn out to be wrong.
Interviewers are grading the reasoning, not the brand. Never trash the alternative — "X is a fine
tool; here's the specific reason it lost *here*."

### Backend framework

**Express vs Fastify?**
Fastify is genuinely faster and has built-in JSON-schema validation. Neither mattered here:
raw HTTP throughput is irrelevant because every expensive operation (CSV import, solving) is off
the request path in background jobs, and we wanted Zod — not ajv/JSON-Schema — because Zod's
inferred types are shared with the frontend through `packages/shared`, which Fastify's validation
story doesn't give us. What Express brings is the most battle-tested middleware ecosystem (multer,
express-rate-limit, Supertest conventions) and zero onboarding surprise. And because the app keeps
Express thin (routes = parse → service → respond, business logic framework-free), the switching
cost if we ever needed Fastify's throughput is a day, not a rewrite. Concede: Express 4 doesn't
catch async errors natively — we wrapped handlers in an `asyncHandler` to funnel rejections to the
error middleware, which Fastify gives you for free.

**Express vs NestJS?**
Nest's value is imposed structure — DI, modules, decorators — which pays off in large teams and
large codebases. Here the structure already exists *without* the framework: routes / services /
pure `engine/`, with the layering enforced by ESLint (`no-restricted-imports` on `engine/**`)
rather than by a DI container. Nest would add an abstraction tax and actually *obscure* the
property we care most about — that the engine is provably framework-free — behind injection
tokens. For a small-team codebase, plain modules are easier to read, test, and onboard into.

### Database & ORM

**Postgres vs MySQL?**
Three Postgres features are load-bearing in this design: **partial unique indexes** (the "at most
one non-terminal import task per company+kind" invariant is a `WHERE status IN (...)` unique
index — MySQL can't express that), **functional indexes** for case-insensitive company-name
uniqueness (`lower(name)`), and `SELECT … FOR UPDATE SKIP LOCKED`, which is what makes pg-boss's
job claiming safe across worker replicas. Plus JSONB for alert detail payloads. Postgres isn't
just "the default good database" here — the design leans on its specific constraint vocabulary.

**Postgres vs MongoDB?**
The domain is relational and the design's strongest pillar is invariants enforced *by the
database*: unique national ID, one contract per worker, one roster per company+month, composite PK
preventing duplicate slot assignment even under concurrent edits. In a document store those become
application-level checks — exactly the kind that fail under concurrency. There's no schema
flexibility need: the entities are stable and known.

**Prisma vs Drizzle?**
Drizzle is closer to SQL, lighter, with excellent type inference — a real contender. Prisma won on
two things: **schema-first declarative migrations** (`schema.prisma` is a single readable artifact
that doubles as the data-model documentation — ours is transcribed almost verbatim from the design
doc, so design and schema visibly match) and a mature `migrate deploy` story that our one-shot
`migrate` compose service depends on. Concede honestly: Prisma's DSL can't express functional or
partial indexes — we hand-wrote raw SQL migrations for both — and Prisma 7 forced a driver-adapter
setup. If the project were more SQL-heavy (reporting, window functions everywhere), Drizzle would
have been the better call; our queries are simple and constraint-heavy, which is Prisma's sweet
spot.

**Prisma vs TypeORM?**
TypeORM's decorator-based entities blur data and behavior and its type safety is weaker (broken
queries can compile). Prisma's generated client makes an invalid query a compile error, which
compounds with this repo's strict TS config.

**Why any ORM at all vs Knex/raw SQL?**
Typed queries against a typed schema, and migrations as first-class artifacts. But we didn't take
ORM purity as a rule — wherever Prisma couldn't express the invariant, we dropped to raw SQL in
the migration rather than weakening the invariant. Tools serve the design, not the reverse.

### Validation

**Zod vs Joi/Yup?**
Joi and Yup validate; Zod validates **and produces the TypeScript type** (`z.infer`). That's the
whole game here: `packages/shared` declares each schema once and both the API (runtime validation)
and the frontend (static types) consume it — request shapes and validation literally cannot
drift. Joi predates TS-first design and its inference is an afterthought; Yup's inference is
weaker on strict/discriminated shapes. We also use Zod features that map directly to real needs:
`.strict()` objects rejecting unknown keys at trust boundaries, and `discriminatedUnion` for
parsing the solver's alert output.

**Zod vs class-validator?**
class-validator wants class instances and decorators (it's the NestJS-native choice) — but our
data is plain JSON at a boundary, not classes, and decorator-based validation can't be shared with
a React frontend as cheaply as a plain schema object.

**Zod vs ajv (JSON Schema)?**
ajv is the fastest validator and JSON Schema is the interop standard. But JSON Schema is verbose
to author, and deriving TS types from it needs extra tooling (typebox et al). Validation speed is
nowhere near a bottleneck; developer-facing ergonomics and single-source-of-truth types are worth
more here.

### Job queue

**pg-boss vs BullMQ?**
BullMQ is the stronger raw queue — but it requires **Redis**: a second stateful service to run,
back up, monitor, and compose, and a queue that can't be transactionally consistent with the data
it describes. pg-boss keeps the queue *in Postgres* (claims via `SKIP LOCKED`), so the entire
system has exactly one stateful dependency. Decisive detail: pg-boss ships the two primitives this
design actually needs — **cron** (auto-generate next month's draft on the 25th) and
**singleton/stately policies** (at most one in-flight generation per company+month → clean 409).
With BullMQ we'd get those too, but at the price of Redis. Concede: at millions of small jobs/day,
a Postgres queue becomes the bottleneck and Redis wins — our workload is the opposite shape (few,
heavy jobs), which is exactly where a DB queue is ideal. And the queue sits behind a small
interface, so the swap is contained if the shape ever changes.

**pg-boss vs Graphile Worker?**
Graphile Worker is also Postgres-based and lighter/lower-latency. pg-boss won on built-in
richness: queue policies (`stately` — blocks a duplicate singleton in *any* non-terminal state,
which our cancel-and-replace design leans on), retry/backoff configuration, archival, and cron in
one package. Both are defensible; this was "most requirements covered out of the box."

**pg-boss vs SQS/RabbitMQ/Kafka?**
The deployment target is a self-contained single-host `docker compose up` — a managed cloud queue
breaks that and adds vendor coupling; RabbitMQ is another stateful service to operate; Kafka is a
distributed log for event streams, wildly over-scoped for "run this CSV import once."

### The solver

**CP-SAT vs writing the algorithm ourselves (greedy/backtracking)?**
Greedy assignment can't handle global interplay — it happily spends a worker's hours early in the
month, then can't satisfy someone else's minimum later; adding backtracking to fix that is
reimplementing a constraint solver badly. CP-SAT gives global optimality, a declarative model
(constraints read like the requirements doc), and free lexicographic trade-off handling via the
weighted objective. The 2-shifts/day rule, min/max hours, coverage, and fairness are *one model*,
not four interacting heuristics.

**CP-SAT vs MILP (Gurobi/CPLEX/CBC)?**
This problem is nearly pure boolean scheduling with logical constraints — CP-SAT's home turf
(employee scheduling is literally OR-Tools' canonical example domain), with convenient exact
integer operators (`add_max_equality`, `add_division_equality`) we use for the fairness term.
Gurobi/CPLEX are commercial licenses; CBC is free but weaker on this class. And CP-SAT is free,
Apache-licensed, Google-maintained.

**CP-SAT vs Timefold/OptaPlanner?**
Those are metaheuristic local-search engines on the JVM — great for huge problems where exactness
is hopeless, but they give "good" solutions without optimality guarantees and add a JVM sidecar
(heavier than a Python script). At our scale (hundreds of workers × 31 days × 3 shifts) CP-SAT
solves to optimality or near it within the 30s cap, deterministically. Exact and reproducible
beats approximate and heavier.

**Why a Python sidecar? Why not keep it in JavaScript?**
We tried to avoid polyglot — but there is no official OR-Tools Node binding, and the JS
alternatives (javascript-lp-solver, glpk-wasm) are toy-grade or LP-only, wrong for a
logical-constraint scheduling model. So the trade was: accept ~250 lines of Python behind a strict
JSON wire contract, keep 100% of orchestration/validation in TypeScript. The polyglot cost is
contained by design — stdin/stdout JSON, Zod-validated output, contract tests on both sides.

**Why a subprocess per job and not a resident solver microservice?**
A subprocess is the simplest correct lifecycle: no state carried between solves, crash isolation
(a solver crash is one failed job, not a down service), memory fully reclaimed after each run, and
no service discovery/auth/health surface between two internal components. Process spawn cost
(~100ms) is noise against a multi-second solve. If solve volume ever demanded a warm resident
service, the JSON contract already *is* the API — promoting it is mechanical.

**Why stdin for the payload and not argv, env, or a temp file?**
Security and simplicity: argv/env leak into process listings and are the classic injection
surface; the contract is `spawn(python, [scriptPath], {shell:false})` with a fixed two-element
argv of build-time constants, so no user-derived byte can ever reach a command line. Temp files
add cleanup, permissions, and race concerns for zero benefit — the problem JSON is megabytes at
most and streams fine.

### Frontend

**React vs Vue/Svelte?**
At this app's size any of the three works; React won on ecosystem depth for the specific things
this app needs — RTK Query, Testing Library, Playwright patterns, mature a11y prior art — plus
hiring/familiarity. The honest answer is "strongest ecosystem, weakest downside," not "React is
better."

**Vite/SPA vs Next.js?**
Next answers questions this app doesn't ask. There's no SEO (internal planner tool), no
content-driven pages, and the deployment model is deliberate: `vite build` emits static files
served by nginx — the frontend has **no server runtime at all**. Next would add a Node process to
run, scale, and secure, and blur the clean SPA-vs-API single-origin split. The one public page
(worker schedule) doesn't need SSR either — it's a token-gated data view, not a crawlable page.
(Vite over CRA needs no defense — CRA is deprecated.)

**RTK Query vs TanStack Query?**
For pure server-cache they're near-equivalent, and TanStack Query is arguably the default choice
today. The tiebreaker: this app also has genuine **client** state — the roster editor's draft
edits, the alert-acknowledgment checklist, dialog state, the active company — which wants Redux
slices. RTK Query rides the same store, middleware, and devtools as those slices: one state
system, one mental model, and job-completion logic can dispatch precise tag invalidations
(`roster-generation` done → invalidate `Roster` + `CostSummary`). TanStack Query + Zustand would
work; it's two libraries and two caches where one integrated system suffices.

**Redux Toolkit vs React Context for that client state?**
Context isn't a state manager — every consumer re-renders on any change, and there's no
devtools/middleware story. We actually use *both* deliberately: Redux for changing state, and a
Context to *provide* the validated active-company id so `useActiveCompanyId()` can return a
guaranteed non-null value below the gate — context as dependency injection of a stable value,
Redux as the store of record.

**Design-token CSS + own component kit vs Tailwind vs MUI/Chakra?**
Two separate questions. Component library: the app needs ~a dozen primitives plus two highly
custom grids (calendar, availability) with hand-built roving-tabindex keyboard navigation — MUI
wouldn't provide those grids anyway, so we'd be paying its bundle/theming tax for buttons and
modals. Owning the kit keeps full a11y control (axe-clean, WCAG-AA tokens for light and dark).
Styling: the tokens/kit CSS is a byte-for-byte copy of the approved design deliverable — the
design handoff *is* the stylesheet, so fidelity is automatic. Tailwind is fine, but it would mean
transcribing the design system into utility classes and losing that 1:1 traceability.

### Monorepo & tooling

**pnpm vs npm/yarn workspaces?**
pnpm's strict, symlinked `node_modules` makes phantom dependencies impossible — in a monorepo
that's the difference between "shared packages declare what they use" and "it works on my machine
because hoisting." Plus content-addressed store speed and the `workspace:*` protocol that the
Docker builds preserve.

**Turborepo vs Nx?**
Nx is more powerful — generators, plugins, project graph, distributed cache — and correspondingly
heavier. We needed exactly two things: topological task ordering (`^build` so `shared` builds
before its consumers) and content-addressed caching, which Turbo does with a single small
`turbo.json`. The clincher is `turbo prune --docker`: it's the backbone of all three Dockerfiles
(minimal cacheable install context per image), Nx has no equivalent that clean. If the repo grew
to dozens of packages with codegen needs, Nx becomes the right answer.

**Monorepo vs separate repos?**
The shared Zod contract package is the reason. In a polyrepo, `shared` becomes a versioned npm
package and every contract change is a publish + upgrade dance across three repos — exactly how
frontend and backend drift. In the monorepo, an API contract change and both its consumers land
in one atomic commit, and Turborepo re-verifies everything affected.

### Testing

**Vitest vs Jest?**
Native ESM and TS with zero transform config, same config universe as Vite (the web workspace
already lives there), Jest-compatible API so no learning cost, and one runner covers both node
(API integration) and jsdom (component) tests. Jest's ESM story is still painful; there was no
countervailing benefit.

**Playwright vs Cypress?**
Three engines including WebKit — our cross-browser coverage is a project matrix
(chromium/firefox/webkit) over every spec, and Safari coverage matters for a planner tool used on
whatever machine is in the guard office. Beyond that: Playwright's `webServer` +
`globalSetup` orchestration natively handles our unusual harness — spawn API, Vite, a DB-admin
fixture server, *and* a pg-boss worker child process (which has no HTTP port and thus can't be a
Cypress-style single-app assumption), against a throwaway Postgres. Cypress's in-browser
architecture makes multi-process orchestration and multi-tab flows harder.

**Real Postgres in tests vs mocking Prisma?**
The invariants live *in the database* — partial unique index behavior, cascades, case-insensitive
uniqueness, the composite PK under concurrent edits. Mocking Prisma tests the mock. The cost —
serial test files against one shared DB — was accepted knowingly (`fileParallelism: false` with a
comment explaining it's real flakiness, not a setting to "fix").

### Infra

**Docker Compose vs Kubernetes?**
The target is a single host and a one-command bring-up. Compose already expresses everything the
deployment needs: healthcheck-gated startup ordering, a one-shot migration service, internal-only
networking, and horizontal API scaling (`--scale api=2`) that proves the API is stateless. K8s at
one node is pure overhead — but because the containers are stateless and 12-factor, the same
images move to K8s unchanged if multi-node ever arrives. "Compose now, K8s when the problem
exists."

**nginx vs Caddy/Traefik?**
Traefik's strength is dynamic service discovery in orchestrated clusters — a static compose file
doesn't need it. Caddy's is automatic TLS — an internal single-origin deployment doesn't need it
yet. nginx does everything this edge actually does — static SPA serving with history-mode
fallback, `/api` reverse proxy with `least_conn` across scaled replicas, per-IP rate limiting on
the one public endpoint, gzip, security headers — in one stock alpine image everyone knows how to
operate.

**nginx vs serving the SPA from Express?**
Serving static files from the API couples frontend deploys to API deploys, wastes Node cycles on
static I/O, and — decisive — breaks the scaling story: with nginx as the one edge, API replicas
are interchangeable proxy targets and the rate limit is enforced once at the edge instead of
per-replica.

**UUID share token vs signed JWT links for the worker schedule?**
A JWT's superpower is *stateless expiry* — but these links shouldn't expire (the printout on the
guard-room wall must keep working), and revocation must be immediate (rotate token), which for a
JWT requires a denylist lookup — i.e., DB state anyway. A random unique token in the DB is
simpler, natively rotatable, requires no secret management, and the endpoint 404s identically for
unknown token vs no data so tokens can't be probed.

**Client polling vs SSE vs WebSockets?**
WebSockets are bidirectional — nothing here is. SSE would be the natural next step (one-way
completion events), but with the API scaled to N replicas it needs a pub/sub backplane or
LISTEN/NOTIFY wiring so the replica holding your connection hears about a job another replica's
worker finished. Polling `GET /api/jobs/:id` every 1.5s is stateless, replica-agnostic, and
self-terminating — for "a human waits a few seconds for a job," it's the right amount of
engineering. The moment requirements include live multi-user roster co-editing, that calculus
flips.

### Small ones worth having ready

- **`Decimal(8,2)` for money, not float** — binary floats can't represent 0.1; hourly-cost math
  must be exact.
- **Native Postgres enums vs lookup tables** — the value sets (roles, shift types, statuses) are
  closed and stable domain vocabulary; the DB itself rejects invalid values. Trade-off: adding a
  value needs a migration — acceptable for genuinely closed sets.
- **multer vs busboy** — busboy is the low-level parser multer wraps; multer gives memory storage,
  size/count limits, and file-type filtering declaratively in the Express idiom.
- **csv-parse vs PapaParse** — PapaParse is browser-first; csv-parse is the Node-native tokenizer
  with a sync API that fits the job-handler context, and parsing happens server-side only.
- **Prisma `@updatedAt` vs DB triggers** — one less thing to migrate and debug; the ORM already
  owns every write path.

---

## 13. Deep dives — "walk me through how it actually works"

These are the two flows you're almost guaranteed to be asked to narrate on a whiteboard. Practice
saying them out loud in order.

### 13.1 The queue — what it is, how it works, why it exists

**Q: Why does the system need a queue at all?**

Four reasons, in order of importance:

1. **Heavy work doesn't belong in an HTTP request.** A 10,000-row CSV import or a 30-second
   CP-SAT solve would tie up a request worker and hit proxy timeouts. The request does only cheap
   validation and returns `202 {jobId}` in milliseconds.
2. **Durability.** A job is a **row in Postgres**. If the worker process crashes mid-import or
   the machine restarts, the job is still there and gets picked up again — nothing is lost with
   the process. An in-memory "just run it async" approach loses work on every crash.
3. **Controlled retries.** Failures re-run automatically (`retryLimit: 2` with backoff) — safe
   only because both handlers were designed idempotent first.
4. **Independent scaling and isolation.** The API process *only sends* jobs; a separate worker
   process *only executes* them. CPU-heavy solving can never degrade HTTP latency, and worker
   replicas scale independently of API replicas.

**Q: How does pg-boss actually work under the hood?**

It's "a queue implemented as Postgres tables." pg-boss owns its own `pgboss` schema (`job`,
`archive`, `schedule` tables), created and migrated by the library itself — outside Prisma.

- **Enqueue** = `INSERT` a row: queue name, JSON payload, state `created`, plus options
  (singletonKey, retry policy).
- **Claim** = the worker polls with `SELECT … FOR UPDATE SKIP LOCKED` and flips the row to
  `active`. `SKIP LOCKED` is the magic: a second worker replica querying at the same instant
  simply *skips* rows already locked by the first — no distributed lock, no double-processing,
  correct by construction. This is why scaling worker replicas needs zero code.
- **Lifecycle**: `created → active → completed | failed | cancelled`, with `retry` in between on
  failure until the retry limit. The handler's return value is stored on the row as `output` —
  that's exactly what `GET /api/jobs/:id` serves back to the polling UI.
- **Cron** = rows in `pgboss.schedule`; pg-boss fires them on schedule (ours: `0 6 25 * *` →
  enqueue next month's draft generation).

**Q: How is the queue wired into the two processes?**

- **API side** (`index.ts`): constructs a PgBoss instance but starts it lazily and memoized —
  it only ever `send()`s and reads job rows. It never registers handlers.
- **Worker side** (`worker.ts`, its own container): `boss.start()`, then `boss.work(queue,
  handler)` for each of the three queues — `csv-import`, `availability-import`,
  `roster-generation` — plus the cron registration.
- **Concurrency is tuned per queue by workload shape**: CSV queues are I/O-bound →
  `localConcurrency: 8` (sized to stay under the Prisma pool of 10); roster generation is
  CPU-bound (each solve is a whole single-threaded Python process) → `2`. Each is env-tunable.
  pg-boss and Prisma get separate connection-pool caps so they can't starve each other.

**Q: What guarantees "only one at a time" where it matters?**

`singletonKey` + the **`stately` queue policy**. Stately adds a DB uniqueness constraint on
`(queue, state, singletonKey)` such that a second job with the same key is rejected while an
existing one is in *any* non-terminal state — created **or** active. So:

- `roster-generation` keyed `"companyId:month"` → you can't double-generate the same month;
  the blocked `send()` returns `null` and the API maps that to `409 generation-in-progress`.
- import queues keyed `"companyId:kind"` → one in-flight import per company per kind, while
  *different* companies run genuinely in parallel.

The gotcha worth telling: the key is **mandatory** in this design — stately's index coalesces a
missing key to `''`, so a single keyless job would silently make the whole queue single-flight
across every company. We reproduced that failure deliberately before trusting the design.

### 13.2 The CSV import flow — end to end

Narrate it as a lifecycle; every step has a reason.

1. **UI, before upload** (`CsvPanel`): the file picker is scoped to the active company. Before
   submitting, the panel calls `GET /api/import-tasks/active?companyId&kind` — if an import is
   already in flight, it shows a confirm dialog ("uploading now will cancel it"). That's UX
   courtesy only; the backend enforces correctness regardless.
2. **The request**: `POST /api/import/workers`, multipart with `file` + `companyId`. Multer with
   **memory storage** (no disk spool), 2MB cap, single file, extension + MIME allowlist — one
   shared config for both CSV routes so they can't drift.
3. **Cheap synchronous validation in the route** — garbage never reaches the queue: exact header
   check, `MAX_ROWS = 10,000` cap, Zod on the form fields. Any failure is an immediate 400 with
   nothing enqueued.
4. **Cancel-and-replace** (`beginImportTask`): if a non-terminal `ImportTask` exists for this
   (company, kind), mark it `CANCELLED` and `boss.cancel()` its job; then create a fresh
   `PENDING` task row. Two same-instant uploads can race this sequence, so there's a **DB
   backstop** — a partial unique index allowing at most one non-terminal task per (company,
   kind) — and the whole cancel→create→enqueue sequence retries up to 5× on either a
   unique-constraint violation or a lost pg-boss singleton slot. (A single attempt was proven
   insufficient by a rapid-fire re-upload load test.)
5. **Enqueue**: `boss.send('csv-import', payload, {singletonKey: 'companyId:WORKER_SYNC'})`; the
   task row is stamped with the returned `pgBossJobId` (that's how the handler later knows *which*
   task it's executing). API responds **`202 {jobId}`**.
6. **Worker picks it up**: claims the job via SKIP LOCKED, adopts the `ImportTask` by matching
   `pgBossJobId`, flips it to `PROCESSING`.
7. **The row loop** — the heart of it:
   - each row is validated in full (Zod shape + Israeli-ID checksum);
   - each **valid row runs in its own transaction**: upsert worker + contract keyed by
     `national_id` — so a failing row rolls back only itself and the batch continues;
   - a `national_id` that already exists **under a different company** is a per-row error, never
     a silent reassignment;
   - each touched worker is stamped with `lastImportTaskId` (the presence-tracking mechanism);
   - progress counters (`processedRows` etc.) update as it goes — that's what the UI's progress
     bar reads;
   - every ~50 rows the handler **re-reads its own task status** — if a newer upload cancelled
     it, it stops cooperatively (because `boss.cancel()` cannot interrupt running code).
8. **Completion**: task → `COMPLETED`, and the job's stored output is the full report:
   `{totalRows, inserted, updated, failed, errors: [{row, field, message}...]}`.
9. **UI closes the loop**: `useJobPolling` hits `GET /api/jobs/:id` every 1.5s; on `completed` it
   stops polling, invalidates the `Worker` cache tag (tables refetch), and renders the per-row
   error report.
10. **The downstream effect**: roster generation only considers workers whose stamp matches the
    company's **latest completed** sync — or who were never CSV-managed (`null` stamp). So a
    worker absent from the newest file stays ACTIVE but silently drops out of rostering until
    they reappear. That replaced the old destructive "deactivate absentees" sweep, which had a
    real cross-company bug.

**Availability CSV — same skeleton, three differences**: it's month-scoped (`POST
/api/import/availability/:month`, and the header must have exactly that month's `dNN` day columns
— a 31-column file against a 30-day month is a 400 before enqueue); a valid row **replaces that
worker's entire month** of availability rows; and there is **no sync sweep** — workers absent from
the file keep whatever availability they had. Two different "what does absence mean" semantics is
exactly why they're two files, not one.

### 13.3 The roster/shift generation flow — from click to published

1. **Kick-off**: planner picks a month, clicks Generate → `POST /api/rosters/generate` with
   `{month, force?}` for the active company. Regenerating an already-published month requires
   `force: true` (it reopens as draft). Enqueue with `singletonKey "companyId:month"`; a `null`
   send (already in flight) → `409`. Response: `202 {jobId}` — the API never waits on the solver.
2. **Worker loads inputs** (this is the only DB-touching part before persist): eligible workers
   (ACTIVE + the import-presence rule), their contracts, the company's staffing-requirements
   matrix (role × shift headcounts), and the month's `WorkerAvailability` rows.
3. **Build the problem** (`engine/problem.ts` — pure, no framework imports): compute the month's
   date list, cross the 9-cell requirements matrix with every date (the wire format is
   per-(date, shift, role)), and emit per-worker `date → [shifts]` availability as a plain JSON
   record. Missing date key = unavailable — no default is fabricated.
4. **Run the solver** (`runSolver.ts`): `spawn(python3, [solve_roster.py], {shell:false})`,
   problem JSON written to **stdin only**, 35s Node-side kill timeout (just above the solver's
   own 30s cap so Python gets to fail cleanly first).
5. **Inside Python** (`solve_roster.py`): build the CP-SAT model — boolean vars only where
   availability allows; hard constraints (coverage-with-slack, ≤2 shifts/day, max hours); soft
   slacks (coverage shortfall, min-hours deficit); weighted objective
   `10000·coverage + 100·deficit + 1·fairness-spread`. Solve deterministically (seed 42, one
   search thread, 30s limit) and print **sorted** assignments + alerts as JSON on stdout. By
   construction it can't be infeasible — slacks absorb any shortage.
6. **Back in Node**: stdout is *untrusted* until it passes the strict Zod
   `solverSolutionSchema`; a non-zero exit becomes a typed `SolverProcessError` with stderr.
7. **Persist the draft — one transaction**: delete the month's existing draft shifts and alerts
   (cascade wipes `shift_workers`), then create one `Shift` row per (date, shiftType), the
   `ShiftWorker` rows (with the worker's **role snapshotted** at assignment time), and the
   `Alert` rows. Roster status `DRAFT`, `generatedAt` set. Delete-and-rewrite in one tx is what
   makes the job idempotent — and idempotency is what makes `retryLimit: 2` safe.
8. **UI closes the loop**: job poll hits `completed` with `{rosterId, alertCount}` → invalidates
   `Roster` + `CostSummary` tags → the calendar grid and the alert checklist render.
9. **Manual editing phase**: every add/move/remove hits the TypeScript `RosterValidator` —
   hard violations (3rd shift that day, outside that exact date's availability, role mismatch,
   inactive worker, duplicate slot) are `422`, never persisted; soft ones (max/min hours) are
   `409 confirmRequired` until the identical request is re-sent with `?confirm=true`. Alerts are
   recomputed after each edit so the save gate always reflects the current grid.
10. **Publish**: `POST /rosters/:id/publish` — refused with `409 {unacknowledgedAlertIds}` until
    the planner has acknowledged *every* alert. Then `DRAFT → PUBLISHED`, and only published
    rosters are visible through the workers' public schedule tokens.
11. **The cron path**: on the 25th at 06:00, pg-boss enqueues generation for *next* month —
    planners start from a prepared draft. Cron never publishes; the draft goes through the same
    acknowledge-and-publish gate.

**One-line summary worth memorizing:** *"The API validates and enqueues; the worker loads data,
builds a pure JSON problem, runs a deterministic CP-SAT sidecar over stdin/stdout, Zod-validates
the answer, and persists the whole month in one idempotent transaction; the UI polls the job row;
humans then edit through a shared validator and publish through an alert-acknowledgment gate."*

---

## 14. Quick-fire facts (memorize)

- Shifts: A 00–08, B 08–16, C 16–24; 8h each; hard cap 2 shifts/day; C→next-day-A is legal.
- Roles: General Guard, Supervisor, Screener. Staffing requirement = headcount per role × shift.
- Solver: OR-Tools CP-SAT, Python 3.11, seed 42, 1 search worker, 30s limit; weights
  10,000 / 100 / 1 (coverage / min-hours / fairness).
- Stack: Express 4, Prisma 7 (pg driver adapter), pg-boss 12, Zod 3, React 18, Vite 6, RTK Query,
  Playwright, Vitest, pnpm + Turborepo (4 workspaces), Node 24, Postgres 16.
- Statuses: Roster `DRAFT → PUBLISHED` (publish gated on acknowledging all alerts; regenerating a
  published month requires `force` and reopens as draft).
- Jobs: 3 queues (`csv-import`, `availability-import`, `roster-generation`), `stately` policy,
  singletonKey `companyId:month` / `companyId:kind`, retryLimit 2, cron `0 6 25 * *`.
- Limits: JSON 100kb global / 2MB availability PUT; CSV 2MB, 10k rows; nginx body 3MB; public
  schedule rate limit 30/min/IP.
- TS strictness: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any`, no `!` —
  and "absent = meaningful" is a domain rule the type system enforces.
