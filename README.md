# Rostering System

A workforce rostering system for a 24/7 security-staffing operation: each company manages its own
workers and contracts, and a constraint-solver engine auto-generates a monthly shift schedule (three
daily shifts: A 00:00–08:00, B 08:00–16:00, C 16:00–00:00) respecting worker availability, role
requirements, and contracted hour limits. Includes manual roster editing, CSV import/export, a cost
dashboard, and a public read-only schedule link for workers (no worker accounts needed).

For the full technical design (architecture, data model, complete API reference, background-job
internals, deployment/scaling) see
**[`docs/design/rostering-system-design.html`](docs/design/rostering-system-design.html)**. This
README only covers: what the product is, how to run it, where to upload a CSV, and what's
deliberately out of scope.

## How to run it

**Prerequisites:** Docker (or OrbStack) with Compose v2. Node.js 24 + pnpm only needed for local
(non-Docker) development.

**One command, no manual setup:**

```bash
cp .env.example .env
docker compose up --build --scale api=2
```

Serves the whole app (SPA + API) at **http://localhost**. Seed sample data (idempotent):

```bash
docker compose run --rm migrate node_modules/.bin/tsx prisma/seed.ts
```

Tear down with `docker compose down` (add `-v` to also drop the database).

**Local dev (without Docker for the app itself):**

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d      # dev Postgres + pgAdmin only
cp .env.example .env
pnpm --filter @rostering/api db:migrate
pnpm --filter @rostering/api db:seed
pnpm dev                                             # starts the API + web dev servers
pnpm --filter @rostering/api exec tsx src/worker.ts  # separate terminal — see note below
```

> **`pnpm dev` does not start the background worker process.** CSV imports and roster generation
> will accept the request (`202 {jobId}`) but never actually complete unless the worker is also
> running — `pnpm --filter @rostering/api exec tsx src/worker.ts`, in its own terminal. This is the
> single most common "why is nothing happening" gotcha in local dev. The one-command Docker path
> above starts the worker automatically; this manual path does not.

## Uploading a CSV

Two separate uploads, both scoped to one company (send `companyId` as a multipart form field
alongside the file — the UI does this automatically for whichever company is currently active).
Both return `202 {jobId}` immediately (processed in the background — poll `GET /api/jobs/:id` or
`GET /api/import-tasks/active?companyId=&kind=`), and uploading again for the same company while
one is still processing cancels the old one and takes over. Full spec:
**[`docs/csv-schema.md`](docs/csv-schema.md)**.

### `POST /api/import/workers` — worker roster

```
national_id,name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours
000000018,Noa Levi,General Guard,Active,45.00,120,200
```

- `national_id` — 9-digit Israeli ID (checksum-validated), the upsert key.
- `role` — `General Guard` | `Supervisor` | `Screener`. `status` — `Active` | `Inactive`.
- Full sync of the file's rows only: a worker matched by `national_id` is updated, an unmatched
  one is created. A worker *absent* from the file is **not** deactivated — it just becomes
  ineligible for roster generation until it reappears in a completed upload.

### `POST /api/import/availability/:month` — that month's availability

```
national_id,d01,d02,d03,...,d31
000000018,ABC,ABC,AB,...,ABC
```

- One `d`-prefixed column per real calendar day of `:month` (28–31 columns, matching that month's
  actual day count).
- Each cell is empty, or an ordered subset of `A`/`B`/`C` (`A`, `AB`, `ABC`, …) — no duplicates,
  always in `A`&lt;`B`&lt;`C` order. Currently: empty = unavailable that date, letters listed =
  the shifts the worker can work that date. (This meaning is being inverted in an in-progress
  change — see the design doc's roadmap.)
- Replaces that worker's entire month; workers/dates absent from the file are simply untouched.

## Out of scope

- **No authentication, anywhere.** No login/session/JWT/API key on any route (except a per-worker
  share-token on the public schedule link, which is access control, not login). Appropriate for a
  trusted, single-operator deployment — not for exposing to the public internet or multiple
  mutually untrusting parties without adding an auth layer first.
- **No role-based permissions or audit trail.** Single planner/HR user model.
- **No CORS configuration** — by design; the deployment serves the SPA and API from one origin via
  nginx, so cross-origin requests are never expected.
- **No WebSockets/push.** Async results are delivered by client polling.
- **Partial/range-scoped roster regeneration is not implemented** — generating a roster always
  rebuilds the entire month from scratch.
