# Rostering System — Design Brief

Slug: `rostering-system`
PRD source: `/Users/omerrabi/Documents/rostering-system/docs/prd/rostering-system-prd.html`

## Feature Summary
A single web platform for a 24/7, single-site security operation that unifies worker and contract management with automatic monthly shift scheduling. The system auto-assigns workers to a monthly roster of three fixed daily shifts while honoring each worker's contracted availability and min/max monthly hours, replacing manual spreadsheet rostering and surfacing staffing gaps before the roster is saved.

## Core User Flows
- HR staff create/read/update/delete workers (name, validated 9-digit Israeli ID, role, Active/Inactive) and their contracts (hourly cost in ILS, weekday+shift availability, min/max monthly hours).
- HR bulk-imports workers + contracts via CSV (per-row validation, never aborts whole import) and exports the full list in a re-importable format.
- Planner configures required headcount per role, per shift, in a settings screen.
- Planner generates a roster for a target month; the system auto-assigns workers and displays a monthly calendar/grid of shift slots with assigned workers.
- Before saving, planner reviews warn-and-confirm alerts (unfillable shifts with detail, per-worker minimum-hours shortfalls) and must explicitly acknowledge each alert to save.
- Planner manually edits the generated calendar (move/add personnel); hard-rule violations are blocked outright, soft (min/max hours) issues warn and require confirmation.
- Planner views projected monthly labor cost per roster and per worker (cost dashboard enhancement).
- A worker views or prints a read-only page of their own monthly schedule (enhancement; no login).

## Key Capabilities
- Worker CRUD with Israeli-ID validation and Active/Inactive status; inactive workers are excluded from rostering.
- Per-worker contracts: hourly cost (ILS), availability by weekday and shift, minimum and maximum monthly hours.
- Configurable staffing requirements: required headcount per role (General Guard, Supervisor, Screener) per shift.
- Automatic roster generation for a target month satisfying: availability patterns, min/max monthly hours, and the hard 2-shifts-per-calendar-day cap.
- Monthly calendar/grid UI of shift slots and assigned workers.
- Pre-save alerting: detect and detail unfillable shifts and minimum-hours shortfalls; save gated on explicit per-alert acknowledgment.
- Constraint-aware manual editing: hard rules (2-of-3 daily cap, availability) blocked; min/max hours violations warn-and-confirm.
- CSV import/export: documented schema, sample file with at least 10 workers, per-row error reporting, export re-importable unmodified, import upserts existing workers matched by ID. Import is a full workforce sync (2026-07-17, user requirement): existing workers absent from the file are set Inactive (never deleted); present-but-invalid rows do NOT deactivate; UI warns before upload and the report lists deactivated workers.
- Cost projection: monthly labor cost per roster and per worker computed from hourly rates.
- Read-only per-worker schedule page or export/print.

## Constraints & Requirements
- Single site; 24/7 operation; three fixed daily shifts: A (00:00–08:00), B (08:00–16:00), C (16:00–00:00).
- Hard rule: no worker may work more than 2 shifts in a calendar day — must be impossible to violate (blocked in both auto-generation and manual edits).
- Availability is a static weekly pattern from the contract; no ad-hoc unavailability (vacation/sick leave) modeling.
- Zero contract violations is a stated success criterion: availability, min/max monthly hours, and the daily cap must always be honored (min/max via warn-and-confirm on save/edit).
- Three roles only: General Guard, Supervisor, Screener.
- 9-digit Israeli ID with validation; ID is the match key for CSV import updates.
- Planner-facing system: no worker logins or notifications; the worker view is read-only page/printout.
- No labour-law simulation beyond the 2-shifts-per-day cap; no multi-site support.
- Tie-breaking assumption: when multiple valid rosters exist, prefer even distribution of hours among eligible workers.
- Currency is ILS; must scale with significant workforce growth.
- Alerts must occur before saving, not after the month starts; saving requires explicit acknowledgment of each alert.

## Design Considerations
Open questions the technical designer must decide (per the PRD; do not treat as solved):
- Roster lifecycle: draft vs. published states, regeneration/editing of an already-saved month, and who approves a roster.
- Rest rules across days: whether back-to-back scheduling across midnight (Shift C then next day's Shift A) is acceptable, and if not, how it is enforced.
- User permissions and audit: whether role-based permissions (HR vs. planner) and a change history of roster edits are needed.
- Budget limits: whether the cost dashboard only displays projections or also warns/enforces against budget thresholds.
- Scheduling engine approach: how to satisfy the constraint set and the even-hours-distribution preference (algorithm choice, determinism, performance at grown workforce sizes).
- How the "even distribution" preference interacts with min-hours shortfall detection and partial infeasibility (what the engine does when no fully valid roster exists).
- Data model and access for the read-only worker schedule view given there are no worker logins (URL scheme, export/print mechanism).
- CSV schema design that keeps a combined workers+contracts export re-importable unmodified, including availability-matrix encoding.

## Design Scope
- Design type: System / Architecture (full-stack: frontend, backend, scheduling engine, data)
- Sections: Components & Responsibilities, Data Model, Scheduling Engine Flow, Background Jobs & Workers, UML Diagram (animated)
- Background workers (added 2026-07-16 per user): async job queue (DB-backed) with a CSV-import worker, a roster-generation worker, and a cron scheduler that auto-generates next month's draft roster; UI polls job status; workers reuse the same engine/validator/CSV modules.
- Stack decision (2026-07-16, corrected by user): Node.js + TypeScript backend + React SPA. Defaults unless the user says otherwise: Express, Prisma ORM on PostgreSQL, Zod validation, pg-boss (Postgres-backed queue, SKIP LOCKED) for the job queue and cron scheduling, React + Vite + TypeScript frontend.
- Database (2026-07-16, user requirement): MUST be PostgreSQL — a hard constraint, not a default.
- DB changes (2026-07-17, user requirement): (1) add a Company entity = the worker's EMPLOYER (subcontractor grouping/reporting); workers get company_id FK; rostering stays global across companies. (2) Normalize the shifts–workers connection: a `shifts` table (one row per roster+date+shift type) plus a `shift_workers` junction (shift_id, worker_id) replaces the flat shift_assignments table. (3) General DB optimization pass: proper enums, FK indexes, partial index on active workers, cascade rules, uniqueness constraints preserved.
- Scheduling engine (2026-07-16, user requirement): use Google OR-Tools CP-SAT solver instead of a greedy pass. Since OR-Tools has no official Node.js binding, the roster-generation job worker invokes a small Python solver script (JSON in → JSON out). Model: boolean vars x[worker,day,shift]; hard constraints = availability, role coverage, ≤2 shifts/day, ≤max monthly hours; soft constraints via slack vars = coverage shortfall (→ unfillable_slot alerts) and min-hours shortfall (→ min_hours_shortfall alerts); objective minimizes weighted slacks then a fairness term (even hour distribution); fixed seed + single search worker for determinism.
- Low-level detail requested (2026-07-16): the user wants the design to include low-level detail — full DB schema (columns/types/constraints), REST endpoint reference, module/directory structure, engine pseudocode, validation rules incl. Israeli ID checksum, CSV column spec, and job/queue mechanics.
- UML diagram: yes — animated sequence/component diagram of roster generation, from planner click through engine, alerts, acknowledgment, and save.
