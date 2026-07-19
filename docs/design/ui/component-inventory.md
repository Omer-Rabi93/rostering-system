# Component Inventory — screens × `packages/ui`

Every screen is composed from the same fixed set of reusable components (the set
named in the implementation plan's Phase 8/9). This document is the contract
between the design and the Phase 8 build: each component's variants/props below
are what Phase 8 must implement, and each screen section below is what Phase 9
must compose them into — no screen re-implements table/form/dialog chrome itself.

## The component set

| Component | One-line job |
|---|---|
| `Table` | sortable data grid with row actions |
| `FormField` (+ `Input`/`Select`/`Checkbox`) | labeled, validatable form control |
| `Modal` / `ConfirmDialog` | focus-trapped overlay; ConfirmDialog is a Modal preset for the 409 soft-warning flow |
| `Badge` | small colored label — role / status / shift-letter / alert-severity variants |
| `Toast` | transient status message, `aria-live="polite"` |
| `EmptyState` | zero-data placeholder with a call to action |
| `Spinner` / `JobProgress` | inline loading indicator / polling job progress with `role="status"` |
| `CalendarGrid` | month × 3-shift-row grid with roving-tabindex slot cells |
| `AlertChecklist` | list of alerts, each with an acknowledge checkbox, gating a save/publish action |

---

## 1. `Table`

```ts
type Column<T> = {
  key: string;
  header: string;
  sortable?: boolean;
  align?: "left" | "right";           // "right" for numeric columns (tabular-nums)
  render?: (row: T) => ReactNode;
};

type TableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  sort?: { key: string; direction: "asc" | "desc" };
  onSortChange?: (key: string) => void;
  emptyState?: ReactNode;             // rendered in place of <tbody> when rows=[]
  caption?: string;                   // visually-hidden by default, announced to SR
  footer?: ReactNode;                 // e.g. totals row
  rowActions?: (row: T) => ReactNode; // trailing action cell (Edit/Delete/…)
};
```

Accessibility: `<table>` + `<caption>` (visually-hidden unless the page already
has a visible heading); sortable header cells are real `<button>`s inside `<th>`
with `aria-sort="ascending" | "descending" | "none"` on the `<th>`; row actions are
icon+text buttons, never icon-only without an `aria-label`.

### Used by

| Screen | Columns | Row actions | Notes |
|---|---|---|---|
| Workers list | ID, Name, Company, Role (`Badge` role variant), Status (`Badge` status variant), Hourly cost, Min/Max hrs | Edit, Share link, Deactivate/Delete | sortable on Name, Role, Status; filter row above (see Workers screen) |
| Companies | Name, Worker count | Rename, Delete | Delete disabled/409-explained when worker count > 0 |
| Cost Dashboard — per-company | Company, Workers, Shifts, Hours, Cost (ILS) | — | numeric columns right-aligned, footer = grand total |
| Cost Dashboard — per-worker | Name, Company, Role (`Badge`), Shifts, Hours, Cost (ILS) | — | sortable on Cost descending by default |
| CSV import report | Row #, National ID, Field, Message | — | rendered inside the import result Modal |
| CSV deactivated-workers report | National ID, Name | — | rendered inside the import result Modal, second tab/section |

---

## 2. `FormField` (+ `Input` / `Select` / `Checkbox`)

```ts
type FormFieldProps = {
  id: string;                 // becomes htmlFor target + aria-describedby anchor
  label: string;
  required?: boolean;
  hint?: string;               // helper text, always visible
  error?: string;               // when present: aria-invalid + error text rendered
  children: (inputProps: {
    id: string;
    "aria-invalid"?: true;
    "aria-describedby"?: string; // hint id and/or error id, space-joined
  }) => ReactNode;
};
```

Contract: `FormField` owns the `<label htmlFor={id}>`, the hint `<p id={id+'-hint'}>`,
and the error `<p id={id+'-error'} role="alert">` (or a shared live region — see
per-screen notes), and computes `aria-describedby` as the join of whichever of
those two ids are present. The wrapped `Input`/`Select` never sets these
attributes itself — it receives them as props from `FormField`, so the
association can never drift out of sync.

Variants used across screens: text `Input` (name, ID), numeric `Input` (hourly
cost, min/max hours — `inputMode="decimal"`/`"numeric"`), `Select` (role, status,
company, shift), `Checkbox` (single — e.g. "force regenerate"; and the 7×3
availability matrix, which is a grid of 21 `Checkbox`es composed by the page, each
still wrapped so it has its own accessible name, e.g. "Available Monday, Shift B").

### Used by

| Screen | Fields |
|---|---|
| Worker create/edit form | National ID (`Input`, pattern hint "9 digits"), Name (`Input`), Company (`Select`), Role (`Select`: General Guard / Supervisor / Screener), Status (`Select`: Active / Inactive), Hourly cost ILS (`Input` numeric), Min monthly hours (`Input` numeric), Max monthly hours (`Input` numeric), Availability (21× `Checkbox` in a 7×3 grid) |
| Company form | Name (`Input`) |
| Staffing Requirements | 9× headcount `Input` (numeric, one per Role × Shift cell) |
| CSV import | file `Input[type=file]`, confirm `Checkbox` ("I understand workers not in this file will be set Inactive") — inside a `ConfirmDialog` |

---

## 3. `Modal` / `ConfirmDialog`

```ts
type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  titleId: string;             // id of the element used as aria-labelledby
  title: ReactNode;
  size?: "sm" | "md" | "lg";
  initialFocusRef?: RefObject<HTMLElement>; // defaults to first focusable
  children: ReactNode;
  footer?: ReactNode;
};

type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  body: ReactNode;             // e.g. the 409 warning list from the API
  confirmLabel: string;        // e.g. "Save anyway", "Set Inactive and import"
  cancelLabel?: string;        // default "Cancel"
  destructive?: boolean;       // renders confirm as btn--danger
  onConfirm: () => void;
  onCancel: () => void;
};
```

`Modal` always renders `role="dialog"` `aria-modal="true"` `aria-labelledby={titleId}`,
traps focus, moves initial focus in on open, restores focus to the trigger on
close, and closes on `Escape`. `ConfirmDialog` is `Modal` with a fixed footer
(Cancel + Confirm) — it is the UI shape for every `409 confirmRequired` response
in the API (soft-rule warnings) and for the CSV full-sync warning.

### Used by

| Screen | Modal instance | Trigger → contents |
|---|---|---|
| Workers | Worker create/edit `Modal` (`size="md"`, contains the form) | "New worker" / row "Edit" → `FormField`s |
| Workers | Deactivate `ConfirmDialog` | Delete on a worker with shift history (409) → "This worker has shift history and can't be deleted. Set Inactive instead?" |
| Companies | Company create/edit `Modal` (`size="sm"`) | "New company" / row "Rename" |
| Companies | Delete-blocked `ConfirmDialog` (informational, single "OK" action) | Delete on a company with workers (409) → lists worker count, no destructive action offered |
| Staffing Requirements | none (inline matrix + inline validation, no modal needed) | — |
| Roster calendar | Manual-edit `Modal` (`size="md"`) | click/Enter on a slot cell → add/move/remove worker for that shift, greys out ineligible workers |
| Roster calendar | Hard-rule blocked `ConfirmDialog`-style alert (informational; single "OK", not a confirm — 422 offers no override) | attempted add violates 2-shifts/day, availability, role, or inactive worker |
| Roster calendar | Soft-warning `ConfirmDialog` | attempted add/remove/move triggers 409 (exceeds max / drops below min hours) → "Save anyway" resubmits with `?confirm=true` |
| Roster calendar | Regenerate-published `ConfirmDialog` (`destructive`) | Generate on an already-published month → "Regenerating reopens <Month> as a draft and clears its publish state. Continue?" |
| Cost Dashboard | none | — |
| CSV panel (part of Workers page) | Full-sync warning `ConfirmDialog` (`destructive`) | before upload → states the sync rule, requires the confirm `Checkbox`, "Import" disabled until checked |
| CSV panel | Import result `Modal` (`size="lg"`) | after job completes → two `Table`s (errors, deactivated workers) |
| Public schedule | none (no modals on the public page — see screen 6 rationale) | — |

---

## 4. `Badge`

```ts
type BadgeProps =
  | { kind: "role"; value: "GENERAL_GUARD" | "SUPERVISOR" | "SCREENER" }
  | { kind: "status"; value: "ACTIVE" | "INACTIVE" | "DRAFT" | "PUBLISHED" }
  | { kind: "shift"; value: "A" | "B" | "C" }              // renders the letter + label, e.g. "A · 00–08"
  | { kind: "severity"; value: "warning" | "blocking" | "good" };
```

Every variant renders a **text label**, never a bare color swatch (see
`design-tokens.md` §1.2–1.3 relief rule). `kind="shift"` always spells out the
letter; an optional `showHours` prop appends "00–08"/"08–16"/"16–24" for extra
clarity in dense grids.

### Used by

| Screen | Badge kinds |
|---|---|
| Workers list | `role`, `status` |
| Worker form (read-only header when editing) | `role`, `status` |
| Roster calendar | `shift` (row headers + slot chips), `severity` (cell outline legend) |
| Cost Dashboard (per-worker table) | `role` |
| AlertChecklist | `severity` |
| Public schedule | `shift` (per-row), no `status`/role ever shown (scope-limited payload) |

---

## 5. `Toast`

```ts
type ToastProps = {
  variant: "success" | "warning" | "error";
  message: string;
  onDismiss?: () => void;
};
// Rendered inside a single page-level <ToastRegion aria-live="polite" role="status">
```

### Used by

Every screen with mutations: Workers (save/delete success, 500 generic-error
toast), Companies (rename/delete outcomes), Staffing Requirements (save success,
validation error summary), Roster (add/move/remove outcomes, publish
success/blocked), Cost Dashboard (none — read-only), CSV panel (job submitted /
completed), Public schedule (none — no mutations, no auth state to react to).

---

## 6. `EmptyState`

```ts
type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
};
```

### Used by

| Screen | Empty condition | Copy |
|---|---|---|
| Workers list | no workers match filters / no workers at all | "No workers yet" → action "Add worker"; or "No workers match these filters" → action "Clear filters" |
| Companies | zero companies | "No companies yet" → action "Add company" |
| Staffing Requirements | n/a (matrix always renders all 9 cells, defaulting to 0) — not used here | — |
| Roster calendar | month not yet generated | "No roster for <Month> yet" → action "Generate roster" |
| Cost Dashboard | month not yet generated/published | "No cost data for <Month>" → action "Go to Roster" |
| Public schedule | worker has no published shifts this month | "No shifts published for <Month>" (no action — read-only page) |

---

## 7. `Spinner` / `JobProgress`

```ts
type JobProgressProps = {
  state: "created" | "active" | "completed" | "failed";
  label: string;                 // e.g. "Generating roster for 2026-08…"
  percent?: number;               // indeterminate if omitted
  errorMessage?: string;          // shown when state === "failed"
};
// role="status" aria-live="polite" on the label element; the bar itself is
// decorative (aria-hidden) since the text conveys the same info to SR users.
```

### Used by

Roster calendar (roster-generation job polling → drives `Roster` tag
invalidation on completion), workforce CSV panel (workforce-import job polling →
drives `Worker` tag invalidation). `Spinner` alone (no progress text) is used
for lightweight inline waits: Table loading state, Save button pending state.

---

## 8. `CalendarGrid`

```ts
type CalendarGridProps = {
  month: string;                 // "YYYY-MM"
  days: DayColumn[];              // one per calendar day, 28-31 entries
  shiftRows: ["A", "B", "C"];
  getSlot: (date: string, shift: "A"|"B"|"C") => {
    workers: { id: number; name: string; role: Role }[];
    alertSeverity?: "warning" | "blocking";
  };
  onSlotActivate: (date: string, shift: "A"|"B"|"C") => void; // Enter/Space or click
  focusedSlot?: { date: string; shift: string };  // roving-tabindex state, lifted to rosterEditor slice
};
```

Accessibility: implemented as a semantic `<table>` — day columns as `<th scope="col">`,
shift rows as `<th scope="row">` (A/B/C `Badge`s), each slot a `<td>` with
`tabIndex={0 for the one active cell, else -1}`, `role="gridcell"`,
`aria-selected` on the focused cell, and `aria-label` summarizing contents (e.g.
"Aug 12, Shift B, 3 workers, 1 alert"). Arrow keys move the roving cell
(Left/Right within/between days, Up/Down between shift rows), `Home`/`End` jump to
the first/last day of the row, `Enter`/`Space` calls `onSlotActivate`. See
`kit.js` `initRovingGrid` in this repo's mockups for a working reference
implementation of exactly this behavior.

### Used by

Roster calendar screen only (its centerpiece). Slot chips inside each cell are
small `Badge`-styled worker names; a cell with an unresolved alert gets a colored
inset ring (`warning`/`blocking`) matching `Badge` severity colors, plus the
`aria-label` announcement above — so the alert is never conveyed by the ring
color alone.

---

## 9. `AlertChecklist`

```ts
type AlertChecklistProps = {
  alerts: {
    id: number;
    type: "unfillable_slot" | "min_hours_shortfall";
    detail: string;               // formatted, e.g. "Aug 12 · Shift B · Supervisor — 1 short"
    acknowledged: boolean;
  }[];
  onAcknowledge: (alertId: number) => void;
  onJumpTo?: (alertId: number) => void; // focuses the corresponding CalendarGrid cell
};
```

Accessibility: each row is a `Checkbox` with a real `<label>` naming the specific
alert (not a generic "Acknowledge"), so a screen-reader user hears e.g.
"Acknowledge: Aug 12, Shift B, Supervisor, 1 short, checkbox, not checked" — never
a bare checkbox relying on visual proximity to its text.

### Used by

Roster calendar screen's side panel only. Drives the page-level `gate-status`
strip ("3 unacknowledged — Publish disabled" / "All clear — ready to publish")
and the Publish button's `disabled` state; unacknowledged count and the API's
`unacknowledgedAlertIds` (on a 409 publish attempt) stay in sync because both
read from the same `Roster` RTK Query cache entry.

---

## Cross-screen composition summary

| Screen | Table | FormField | Modal/Confirm | Badge | Toast | EmptyState | Spinner/JobProgress | CalendarGrid | AlertChecklist |
|---|---|---|---|---|---|---|---|---|---|
| 1. Workers | yes | yes (worker form + filters) | yes (form, deactivate confirm, CSV) | role, status | yes | yes | Spinner (list load), JobProgress (CSV) | — | — |
| 2. Companies | yes | yes (name) | yes (form, delete-blocked) | — | yes | yes | Spinner | — | — |
| 3. Staffing Requirements | — (matrix is a bespoke 3×3 grid of FormFields, not a data Table) | yes (9 numeric cells) | — | — | yes | — | Spinner (save) | — | — |
| 4. Roster calendar | — | yes (manual-edit dialog fields: worker picker) | yes (edit, hard-block, soft-confirm, regenerate-confirm) | shift, severity, role (in worker picker) | yes | yes | JobProgress (generation) | **yes — centerpiece** | **yes — side panel** |
| 5. Cost Dashboard | yes (×2: per-company, per-worker) | — | — | role | — | yes | Spinner | — | — |
| 6. Public schedule | — (own read-only shift list, styled as a simple list/table, not the interactive Table with sorting) | — | — | shift | — | yes | — | — | — |
