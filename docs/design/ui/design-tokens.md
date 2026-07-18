# Design Tokens — Rostering System UI

This is the single source of truth for color, spacing, typography, radius, shadow,
and motion tokens used across all 6 screens. The runnable form of these tokens is
`tokens.css` (CSS custom properties) — every mockup in `mockups/*.html` links it.
When Phase 8 builds `packages/ui`, these become the theme file (e.g.
`packages/ui/src/theme/tokens.css` or a TS token object feeding styled-components /
CSS modules — whichever the implementer picks, the values below shouldn't change).

Both a light and a dark mode are specified. Dark mode is a first-class target, not
an afterthought: the roster grid and cost tables are frequently used at length, and
this repo's other design artifact (the technical design doc) doesn't dictate a
theme, so we specify both and let dark mode be selectable (`prefers-color-scheme`
by default, with a `data-theme` override hook for a future in-app toggle).

## 1. Color

### 1.1 Neutrals & surfaces

Adopted from the studio's validated neutral ramp (same values used for chart
chrome elsewhere in this design system) so admin-table-heavy screens and any future
chart/dashboard visuals feel like one system.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-page` | `#f9f9f7` | `#0d0d0d` | app background behind cards |
| `--color-surface` | `#fcfcfb` | `#1a1a19` | card / panel / table background |
| `--color-surface-raised` | `#ffffff` | `#232322` | modal, popover |
| `--color-ink-primary` | `#0b0b0b` | `#ffffff` | body text, headings |
| `--color-ink-secondary` | `#52514e` | `#c3c2b7` | secondary text, helper text |
| `--color-ink-muted` | `#898781` | `#898781` | placeholder, disabled, table captions |
| `--color-border` | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` | hairline borders |
| `--color-border-strong` | `#c3c2b7` | `#383835` | input borders, table rule lines |
| `--color-gridline` | `#e1e0d9` | `#2c2c2a` | calendar grid lines |
| `--color-focus-ring` | `#2a78d6` | `#3987e5` | focus outline (see §5 Accessibility) |
| `--color-brand` | `#2a78d6` | `#3987e5` | primary buttons, links, active nav |

Rationale: near-neutral warm-gray page/surface pair rather than pure white/black —
reduces glare in an always-on planning room, and gives just enough separation
between page and card without a heavy shadow.

### 1.2 Shift accents (A / B / C)

Three categorical hues, run through the palette's CVD/contrast validator
(`validate_palette.js`, both modes) and picked so no pair is confusable and so none
collides with the alert-severity hues below. They double as a light mnemonic for
time of day: A is night, B is daylight, C is dusk.

| Shift | Time | Light | Dark | Mnemonic |
|---|---|---|---|---|
| **A** | 00:00–08:00 | `#2a78d6` (blue) | `#3987e5` | night |
| **B** | 08:00–16:00 | `#eda100` (amber) | `#c98500` | day / sun |
| **C** | 16:00–24:00 | `#1baf7a` (teal) | `#199e70` | dusk |

Validator result (light): lightness band PASS, chroma floor PASS, worst adjacent
CVD ΔE 47.2 PASS, contrast-vs-surface **WARN** for B and C (2.1–2.7 : 1, below the
3:1 AA-non-text floor). Validator result (dark): all four checks PASS.

**Because of the light-mode contrast WARN, shift color is never used as the only
signal.** Every place a shift accent appears, it is paired with the shift letter
as visible text (a `Badge` with a colored left bar/background *and* the glyph
"A"/"B"/"C", never a bare color chip) — see `component-inventory.md` → Badge. This
is the same "relief rule" the dataviz skill applies to near-threshold categorical
colors.

### 1.3 Alert / status severity

Fixed status palette — reserved for state, never reused as a 4th "category" color,
and never overlapping the shift hues above:

| Role | Meaning in this app | Light | Dark |
|---|---|---|---|
| `--color-status-good` | roster valid / all alerts acknowledged / import row OK | `#0ca30c` | `#0ca30c` |
| `--color-status-warning` | soft rule: `min_hours_shortfall`, `unfillable_slot` alerts awaiting acknowledgment (409-class, save allowed after ack) | `#fab219` | `#fab219` |
| `--color-status-blocking` | hard rule violation: 422 rejection on a manual edit (never persisted, no override) | `#d03b3b` | `#d03b3b` |

Two severities is deliberate but the design keeps a 3rd (`good`) for confirmation
states (e.g. "no alerts — safe to publish", CSV row imported cleanly). "warning"
and "blocking" map 1:1 onto the technical design's own vocabulary: **409 soft
warning → requires confirmation, can still save** vs **422 hard violation → always
rejected**. Same as the shift colors, status is always paired with an icon + text
label (see `component-inventory.md` → Badge/Toast/AlertChecklist) — color is never
the only channel, per WCAG 1.4.1.

### 1.4 Role colors (worker role badges)

Roles are identity, not severity or shift — a 4th, independent categorical set so a
Supervisor badge is never mistaken for a shift-B badge or a warning badge:

| Role | Light | Dark |
|---|---|---|
| General Guard | `#52514e` (neutral slate) | `#c3c2b7` |
| Supervisor | `#4a3aa7` (violet) | `#9085e9` |
| Screener | `#e87ba4` (magenta) | `#d55181` |

General Guard intentionally uses ink-secondary rather than a hue — it's the
numerically dominant role, and giving it a loud color would visually overwhelm
tables; Supervisor and Screener (the two roles staffing requirements usually
special-case) get the accent treatment.

## 2. Spacing scale

4px base unit, used for padding, gaps, and margins everywhere — no ad hoc pixel
values in component CSS.

| Token | Value |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |
| `--space-10` | 40px |
| `--space-12` | 48px |
| `--space-16` | 64px |

Layout rule of thumb: `--space-2`/`--space-3` inside controls (button/input
padding), `--space-4`/`--space-6` between form fields and card padding, `--space-8`+
between major page regions.

## 3. Typography

System font stack (matches the rest of this design system — no display/serif
face): `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
sans-serif`.

| Token | Size | Line-height | Weight | Use |
|---|---|---|---|---|
| `--text-xs` | 12px | 1.35 | 400/600 | table captions, badge labels, print footnotes |
| `--text-sm` | 13px | 1.4 | 400/600 | secondary text, form helper/error text, dense table cells |
| `--text-base` | 14px | 1.5 | 400 | body copy, form inputs, default table cell |
| `--text-md` | 16px | 1.5 | 400/600 | page section labels, nav |
| `--text-lg` | 18px | 1.35 | 600 | card titles, modal titles |
| `--text-xl` | 22px | 1.3 | 600 | page titles |
| `--text-2xl` | 28px | 1.25 | 700 | dashboard hero numbers (roster total cost) |
| `--text-3xl` | 36px | 1.2 | 700 | print schedule worker name header |

`font-variant-numeric: tabular-nums` is applied to every table cell and stat-tile
number so hours/cost/ID columns align vertically — never on prose text.

## 4. Radius, elevation, motion

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | badges, chips, input fields |
| `--radius-md` | 8px | cards, table containers, buttons |
| `--radius-lg` | 12px | modals |
| `--radius-pill` | 999px | status pills |
| `--shadow-card` | `0 1px 2px rgba(11,11,11,.06), 0 1px 1px rgba(11,11,11,.04)` | cards |
| `--shadow-modal` | `0 20px 48px rgba(11,11,11,.24)` | modal/dialog |
| `--motion-fast` | 120ms ease-out | hover/focus transitions |
| `--motion-base` | 200ms ease-out | modal/toast enter-exit |
| `--motion-none` | applied under `prefers-reduced-motion: reduce` — all the above collapse to `0ms` | respects reduced motion |

## 5. Accessibility baseline (applies to every screen)

These are cross-cutting rules encoded once here; each screen's mockup and the
component inventory call out where they apply concretely.

- **Focus ring**: `outline: 2px solid var(--color-focus-ring); outline-offset: 2px`
  on every interactive element, including custom ones (calendar cells, badges used
  as buttons). Never `outline: none` without a replacement.
- **Color is never the only channel**: shift, role, and status all pair a color
  with a text glyph/label (letter, role name, icon + word).
- **Contrast**: body text ≥ 4.5:1, large text/icons ≥ 3:1, non-text UI (borders,
  focus rings) ≥ 3:1 against adjacent surface, checked against the tokens above.
- **Motion**: respects `prefers-reduced-motion`.
- **Forms**: every input has a programmatically associated `<label for>`; invalid
  fields get `aria-invalid="true"` plus `aria-describedby` pointing at the error
  text node (see `component-inventory.md` → FormField and every screen's "Error /
  validation state").
- **Dialogs**: `role="dialog"` `aria-modal="true"` `aria-labelledby` pointing at
  the dialog's title, a focus trap, initial focus moved to the first focusable
  element (or the dialog itself when it's a confirm with no form), `Escape` closes
  without applying, and focus returns to the element that opened the dialog.
- **Live regions**: Toast uses `role="status" aria-live="polite"` (non-interrupting);
  JobProgress uses the same for progress text so a screen-reader user hears state
  changes without focus moving away from what they were doing.
- **Calendar grid**: one `tabindex="0"` cell at a time (roving tabindex), the rest
  `tabindex="-1"`; arrow keys move the roving cell (Left/Right within a day's 3
  shift rows and across days, Up/Down across weeks); `Enter`/`Space` opens the
  manual-edit dialog for the focused cell; `Home`/`End` jump to first/last day of
  the visible week (implementation detail, documented in the mockup).
