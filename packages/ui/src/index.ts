// Barrel export for `@rostering/ui`.
//
// Reusable presentational React components built against the approved Phase D UI design
// (`docs/design/ui/`). Every component is styled purely via class names matching
// `docs/design/ui/kit.css`/`tokens.css` (bundled as `dist/styles/index.css`, importable by
// consumers as `@rostering/ui/styles.css`) — see `src/styles/index.css`.

export { Badge, ROLE_CLASS, type BadgeProps } from './Badge/Badge.js';

export { Spinner, type SpinnerProps } from './Spinner/Spinner.js';

export { EmptyState, type EmptyStateProps } from './EmptyState/EmptyState.js';

export { Toast, type ToastProps } from './Toast/Toast.js';
export { ToastRegion, type ToastRegionProps } from './Toast/ToastRegion.js';

export { FormField, type FormFieldProps, type FormFieldInputProps } from './FormField/FormField.js';
export { Input, type InputProps } from './FormField/Input.js';
export { Select, type SelectOption, type SelectProps } from './FormField/Select.js';
export { Checkbox, type CheckboxProps } from './FormField/Checkbox.js';

export { Modal, type ModalProps } from './Modal/Modal.js';
export { ConfirmDialog, type ConfirmDialogProps } from './Modal/ConfirmDialog.js';

export { Table, type Column, type TableSort, type TableProps } from './Table/Table.js';

export { JobProgress, type JobProgressProps } from './JobProgress/JobProgress.js';

export { AlertChecklist, type AlertChecklistProps, type Alert as AlertChecklistAlert } from './AlertChecklist/AlertChecklist.js';

export {
  CalendarGrid,
  type CalendarGridProps,
  type DayColumn,
  type SlotData,
  type SlotWorker,
  type FocusedSlot,
  type Role as CalendarRole,
  type ShiftType as CalendarShiftType,
} from './CalendarGrid/CalendarGrid.js';

export {
  useRovingTabindex,
  neighborFor,
  isNavKey,
  cellKey,
  type GridPos,
  type NavKey,
  type UseRovingTabindexOptions,
  type UseRovingTabindexResult,
} from './CalendarGrid/rovingTabindex.js';
