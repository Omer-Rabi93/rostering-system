import type { ReactElement } from 'react';

const ROLE_LABEL: Record<'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER', string> = {
  GENERAL_GUARD: 'General Guard',
  SUPERVISOR: 'Supervisor',
  SCREENER: 'Screener',
};

// Exported so other components that need the same role -> CSS-class-suffix mapping (e.g.
// `CalendarGrid`'s chip coloring, `SlotEditDialog`'s per-role picker ids) reuse this single
// source of truth instead of re-deriving it from the `Role` enum themselves.
export const ROLE_CLASS: Record<'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER', string> = {
  GENERAL_GUARD: 'guard',
  SUPERVISOR: 'supervisor',
  SCREENER: 'screener',
};

export type BadgeProps =
  | { kind: 'role'; value: 'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER' }
  | { kind: 'status'; value: 'ACTIVE' | 'INACTIVE' | 'DRAFT' | 'PUBLISHED' }
  | { kind: 'shift'; value: 'A' | 'B' | 'C'; showHours?: boolean }
  | { kind: 'severity'; value: 'warning' | 'blocking' | 'good' };

const STATUS_LABEL: Record<'ACTIVE' | 'INACTIVE' | 'DRAFT' | 'PUBLISHED', string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
};

export function Badge(props: BadgeProps): ReactElement {
  if (props.kind === 'role') {
    return (
      <span className={`badge badge--role-${ROLE_CLASS[props.value]}`}>
        {ROLE_LABEL[props.value]}
      </span>
    );
  }

  if (props.kind === 'status') {
    return (
      <span className={`badge badge--status-${props.value.toLowerCase()}`}>
        {STATUS_LABEL[props.value]}
      </span>
    );
  }

  if (props.kind === 'shift') {
    const shiftHours: Record<'A' | 'B' | 'C', string> = {
      A: '00–08',
      B: '08–16',
      C: '16–24',
    };
    const label = props.showHours ? `${props.value} · ${shiftHours[props.value]}` : props.value;

    return (
      <span className={`badge badge--shift-${props.value.toLowerCase()}`}>{label}</span>
    );
  }

  const SEVERITY_LABEL: Record<'warning' | 'blocking' | 'good', string> = {
    warning: 'Warning',
    blocking: 'Blocking',
    good: 'Good',
  };

  return (
    <span className={`badge badge--severity-${props.value}`}>
      {SEVERITY_LABEL[props.value]}
    </span>
  );
}
