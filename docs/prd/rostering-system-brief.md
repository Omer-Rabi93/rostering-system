# Rostering System — Product Brief

Source: "Developer HS.docx" (ICTS Europe, ref. ICTS-PHP-HA-2026-001, issued 2026-06-04)

## Feature Summary
A Rostering System that unifies HR data management with shift planning in a single web platform. It maintains a registry of workers and their employment contracts, and automatically generates valid monthly shift schedules that respect each worker's contract constraints, replacing today's manual spreadsheet-based process.

## Problem / Motivation
Workforce scheduling is currently handled manually with spreadsheets and disconnected tools. This causes frequent scheduling errors, under-staffed shifts, and contract violations that expose the company to unnecessary risk. The business needs one reliable, structured system that keeps HR records and shift planning consistent with each other.

## Target Users
- HR / workforce planning staff at ICTS Europe who maintain worker records and contracts.
- Operations planners / schedulers who generate and adjust monthly rosters for a 24/7 security operation.
- Indirectly: the workforce itself — General Guards, Supervisors, and Screeners — whose shifts and contracted hours the system governs.

## Goals
- Eliminate manual, error-prone scheduling: valid monthly rosters are generated automatically for all active workers.
- Prevent contract violations: schedules always honor availability (days and shifts), minimum/maximum monthly hours, and the hard rule that no worker works more than 2 of the 3 shifts in a single day.
- Surface staffing risk early: planners are alerted to unfillable shifts and to workers falling short of contracted minimum hours before a schedule is saved.
- Keep HR data as the single source of truth driving scheduling, with easy bulk data movement in and out (CSV).
- Support significant workforce growth without the process breaking down.

## Known Requirements
Operating model:
- Continuous 24/7 operation with three fixed daily shifts: A (00:00–08:00), B (08:00–16:00), C (16:00–00:00).
- Hard rule: a worker may not be assigned more than 2 shifts in the same calendar day.
- Three roles: General Guard, Supervisor, Screener.
- No labour-law simulation; the 3-shift rule is the only hard platform constraint beyond contract terms.

HR management:
- Full create/read/update/delete of worker records.
- Worker record fields (minimum): full name; Israeli ID number (9 digits, validated — workers assumed Israeli nationals); role (one of the three); status (Active/Inactive).
- Inactive workers must never appear in rostering.

Contract management (per worker, drives rostering):
- Hourly cost (ILS) for cost estimation.
- Availability by days of week and by shifts (A/B/C).
- Minimum monthly hours the system must schedule.
- Maximum monthly hours that may be scheduled.

CSV import / export:
- Bulk import of workers + contract data; per-row validation with error reporting (e.g., invalid ID, missing fields) without aborting the whole import.
- Export of the full worker list including contract fields; export must be re-importable without modification.
- CSV schema must be documented.
- A sample CSV seeding at least 10 workers must be provided.

Rostering engine:
- Given a target calendar month, automatically produce a valid roster for all active workers respecting all contract constraints and the 3-shift rule.
- Alert before saving if the workforce cannot cover all required shifts, detailing which shifts are unfilled.
- Per-worker alert listing the shortfall if any worker would receive fewer than contracted minimum hours.
- Roster viewable in a clear monthly calendar/grid showing each shift slot and assigned workers.
- Manual adjustments (moving, adding personnel, etc.) must be possible on top of the generated calendar.

Enhancements (mandatory):
- At least 2 additional features of the builder's choosing that deliver genuine operational value to the end user, each documented with a business-value rationale. A submission without them is considered incomplete.
- Creativity is explicitly rewarded (better UX, smarter scheduling, extra validation, etc.).

## Open Questions
1. Shift staffing requirements are undefined: how many workers, and of which roles, are required per shift (e.g., must every shift include a Supervisor and a Screener)? Do staffing needs vary by day, shift, or location? Without this, "insufficient to cover all required shifts" cannot be evaluated.
2. Is the operation single-site, or must the system model multiple sites/locations/posts?
3. Should manual roster edits be validated against the same contract constraints and the 3-shift rule (blocked vs. warned vs. allowed)?
4. Optimization objective: when multiple valid rosters exist, what should the engine prefer — minimum total cost (hourly rates are captured "for cost estimation"), fairness of hour distribution, or something else?
5. What happens after alerts are raised — can a planner save a schedule with unfilled shifts or minimum-hours shortfalls anyway (override), or is saving blocked?
6. Roster lifecycle: can a saved month be regenerated/edited later, are there draft vs. published states, and who approves a roster?
7. Consecutive-day / rest rules: the 2-shifts-per-day cap is stated, but is back-to-back scheduling across days (e.g., Shift C then next day's Shift A) acceptable?
8. Duplicate/uniqueness rules for CSV import: how should a row whose ID already exists be handled — update the existing worker, skip, or error?
9. Users and permissions: who uses the system (HR vs. planners), and are role-based permissions or an audit trail of roster changes needed?
10. Are ad-hoc unavailability events (vacation, sick leave) in scope, or is availability strictly the static weekly pattern in the contract?
11. Cost estimation: beyond storing hourly cost, should the product display projected monthly cost per roster/worker, and are there budget limits to respect?
12. Notifications: do workers need to see or be notified of their own schedules, or is the system planner-facing only?

## Clarifications
- Q: How should shift staffing requirements work (undefined in source)? → A: Configurable per shift — the planner defines required headcount per role (e.g., 1 Supervisor, 2 Guards, 1 Screener) per shift via a settings screen.
- Q: What happens after alerts (unfillable shifts / min-hours shortfalls)? → A: Warn and require confirmation — save is allowed only after the planner explicitly acknowledges each alert.
- Q: Are manual roster edits validated? → A: Block hard-rule violations — the 2-shifts-per-day cap and availability can never be violated manually; min/max hours issues warn but are allowed with confirmation.
- Q: Which 2 mandatory enhancement features to include? → A: (1) Cost dashboard — projected monthly labor cost per roster and per worker computed from hourly rates; business value: budget visibility using data already captured. (2) Worker schedule view — a read-only per-worker schedule page (or export/print) so each guard sees their own month; business value: reduces planner communication overhead and scheduling disputes.
- Q: Multi-site? → A: NO (revised 2026-07-16) — the system models a single site; no site management. Staffing requirements are per shift only.
- Clarified emphasis: the core of the product is AUTO-ASSIGNMENT — the engine automatically assigns workers to shifts so each worker's contracted min/max monthly hours are honored. Manual spreadsheet scheduling is the problem being replaced.
- Q: Other v1 scope defaults? → A: Planner-facing only (no worker logins; the worker schedule view is a read-only page/printout). CSV import updates existing workers by ID (keeps export re-importable). When multiple valid rosters exist, the engine prefers even distribution of hours among eligible workers. These are documented as explicit assumptions.
- Q: What about workers missing from an imported CSV? → A (2026-07-17, user requirement): CSV import is a full workforce sync — any existing worker whose ID does not appear in the file is set Inactive (never deleted; contract and shift history kept). A worker whose row is present but fails validation is NOT deactivated. The UI warns about the sync behavior before upload and the import report lists all deactivated workers.
