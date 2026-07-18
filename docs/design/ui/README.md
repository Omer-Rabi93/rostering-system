# UI Design — Rostering System (Phase D)

Design deliverable for the 6 planner-facing (+1 public) screens, produced in
parallel with backend Phases 2–6, per `.notes/rostering-system-implementation-plan.md`
Phase D. This is the design Phase 8/9 build against — review and approve before
frontend implementation starts.

## What's here

| File | Contents |
|---|---|
| `design-tokens.md` | Color palette (neutrals, shift A/B/C accents, alert severity, role colors), spacing scale, typography scale, radius/elevation/motion, and the cross-cutting accessibility baseline — with rationale for every choice. |
| `tokens.css` | Runnable CSS custom properties for everything in `design-tokens.md`, light + dark. This is the file Phase 8 should turn into the `packages/ui` theme (or a 1:1 TS token object). |
| `component-inventory.md` | Every one of the 9 reusable components (`Table`, `FormField`, `Modal`/`ConfirmDialog`, `Badge`, `Toast`, `EmptyState`, `Spinner`/`JobProgress`, `CalendarGrid`, `AlertChecklist`) with its prop shape and variants, plus a table mapping each of the 6 screens to exactly which components/variants it's built from. |
| `kit.css` | A reference implementation of those 9 components' visual styles, shared by every mockup below (not `packages/ui` itself — a concrete starting point for it). |
| `kit.js` | Working vanilla-JS behavior for the three interaction patterns that matter most for accessibility: modal focus-trap + Escape + return-focus, calendar roving-tabindex + arrow-key navigation, and a toast/job-progress live-region helper. Copy the *behavior*, not the code, into the React implementation. |
| `mockups/01-workers.html` | Workers list + worker/contract create/edit form (Israeli-ID validation, 7×3 availability matrix, role/status), plus the CSV import flow (full-sync confirm → job progress → result report). |
| `mockups/02-companies.html` | Companies CRUD. |
| `mockups/03-staffing-requirements.html` | Role × shift headcount matrix settings. |
| `mockups/04-roster-calendar.html` | Roster calendar grid — month view, 3 shift rows/day, click/keyboard slot editing, alert checklist side panel, publish gate. |
| `mockups/05-cost-dashboard.html` | Cost dashboard — roster total, per-company, per-worker. |
| `mockups/06-public-schedule.html` | Public, token-URL, read-only worker schedule with a print stylesheet. |

**How to review:** open any `mockups/*.html` file directly in a browser (no build
step, no server needed — plain static files). Each page has a "Screen states"
quick-nav at the top linking to stacked sections for **Normal**, **Empty**, and
**Error/validation** states (plus a couple of screen-specific states, e.g. the
generation-in-progress state on the Roster page). Interactive elements — modals,
the calendar's keyboard navigation, the alert checklist gating Publish, the CSV
job-progress bar — are real working demos, not screenshots, so you can Tab/click/
arrow-key through the exact behavior Phase 8 needs to reproduce.

## Key design decisions

**Palette.** Colors were chosen using the studio's dataviz color method (fixed
categorical hue ordering, run through `validate_palette.js` for CVD-safety and
contrast rather than eyeballed) even though this isn't a chart-heavy screen set —
the same rigor matters here because shift and alert colors carry real operational
meaning. Four independent, non-overlapping color families are used: **neutrals**
(warm near-black/near-white, matching this design system's existing chart chrome
so a future dashboard feels like one product), **shift accents** A=blue/B=amber/
C=teal (validated CVD ΔE 47.2, chosen with a light night→day→dusk mnemonic),
**alert severity** (good=green, warning=amber, blocking=red — mapping directly
onto the technical design's own 409-soft-warning vs. 422-hard-violation
vocabulary), and **role colors** (guard=neutral slate since it's the numerically
dominant role, supervisor=violet, screener=magenta). Because two of the three
shift hues sit below 3:1 contrast at normal text size on a light background, the
palette is used under a strict rule: **color is never the only signal** — every
shift, role, and severity badge always renders its letter/name/icon as visible
text, so the design is legible in grayscale, print, and to colorblind users
without relying on hue discrimination.

**Grid interaction model.** The `CalendarGrid` is one semantic `<table>` for the
whole month (day columns × 3 shift-row `<tr>`s), not a month-block calendar —
matching the technical design's flat day×shift×role slot model and letting the
grid scroll horizontally for a 28–31-day month without changing its row
structure. Editing is click-or-keyboard, never drag-only: every slot cell is a
`role="gridcell"` with a roving `tabindex` (one cell is `0`, the rest `-1`),
arrow keys move focus between cells, and `Enter`/`Space` opens the same
add/move/remove dialog a mouse click would. This keeps the primary interaction
keyboard-operable by construction (a Playwright a11y/keyboard test scenario is
already specified in the implementation plan) — drag-and-drop, if added later, is
a secondary enhancement layered on top of the same click/keyboard path, never a
replacement for it.

**Alert gate as UI, not just API contract.** The technical design blocks publish
server-side until every alert is acknowledged; the mockup makes that gate visible
and interactive client-side too — the `AlertChecklist`'s checkboxes drive a live
`gate-status` region and the Publish button's `disabled` state in real time (see
`mockups/04-roster-calendar.html`), so the Phase 9 implementation has a concrete
reference for wiring the same behavior off the `Roster` RTK Query cache instead of
local component state.

**Accessibility is load-bearing in the mockups, not a checklist appended after.**
Every form field's label/input association, `aria-invalid`/`aria-describedby`
pairing, dialog focus-trap/`Escape`/return-focus, and live region is implemented
in working markup and JS in `kit.css`/`kit.js`, and called out inline via
`.annotation` callouts on each screen — see `design-tokens.md` §5 for the
cross-cutting rules these all follow.

**Dark mode is first-class, not deferred.** All tokens are specified for light
and dark (`prefers-color-scheme` by default, `data-theme` attribute override for
a future in-app toggle) since the roster grid and cost tables are used at length
in a planning-room setting.

## What Phase 8/9 should NOT need to re-derive

- Exact hex values and their light/dark pairs — `tokens.css`.
- Which component owns which prop/variant — `component-inventory.md`.
- The focus-trap/roving-tabindex/live-region *behavior* — `kit.js` (reference
  implementation; port the logic, not the vanilla-JS DOM calls, into React).
- Screen composition (which components, in what states) — the screen ×
  component table at the end of `component-inventory.md`.

## Open items for reviewer sign-off

- Confirm the shift-letter mnemonic (A=night/blue, B=day/amber, C=dusk/teal) reads
  well to an ICTS planner, or swap for a different but equally CVD-validated
  triple if there's an existing brand convention.
- Confirm two severities (`warning`, `blocking`) plus a `good` confirmation state
  is sufficient — the brief's alert types (`unfillable_slot`,
  `min_hours_shortfall`) are both modeled as `warning` (they gate publish via
  acknowledgment, matching the design's 409-class semantics); `blocking` is
  reserved for in-the-moment 422 rejections during manual edits, which are never
  persisted and have no acknowledgment step.
- The public schedule mockup keeps CSS in-page rather than sharing `kit.css`'s
  topbar, by design (no authenticated chrome on an unauthenticated page) — confirm
  this separation should hold in the real routing setup too (a distinct
  `PublicSchedule` page/layout, not a themed variant of the authenticated shell).
