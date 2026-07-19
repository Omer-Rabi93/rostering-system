import { formatDate } from '../engine/calendar.js';
import { ROLES } from '@rostering/shared';
import type { Role, ShiftType } from '@rostering/shared';

import type { Prisma } from '../generated/prisma/client.js';

export interface AlertDto {
  readonly id: number;
  readonly type: 'UNFILLABLE_SLOT' | 'MIN_HOURS_SHORTFALL';
  readonly detail: unknown;
  readonly acknowledged: boolean;
  readonly acknowledgedAt: string | null;
}

export function toAlertDto(alert: {
  id: number;
  type: string;
  detail: unknown;
  acknowledged: boolean;
  acknowledgedAt: Date | null;
}): AlertDto {
  return {
    id: alert.id,
    type: alert.type as AlertDto['type'],
    detail: alert.detail,
    acknowledged: alert.acknowledged,
    acknowledgedAt: alert.acknowledgedAt ? alert.acknowledgedAt.toISOString() : null,
  };
}

/** Order-independent JSON key comparison, so Postgres JSONB round-tripping can never desync an
 * alert's `detail` from the target we just computed (JSONB does not guarantee to preserve key
 * insertion order across every code path that touches it). */
function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    return `{${sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface UnfillableSlotTarget {
  readonly type: 'UNFILLABLE_SLOT';
  readonly detail: { readonly date: string; readonly shift: ShiftType; readonly role: Role };
}

interface MinHoursShortfallTarget {
  readonly type: 'MIN_HOURS_SHORTFALL';
  readonly detail: { readonly workerId: number; readonly deficitHours: number };
}

type AlertTarget = UnfillableSlotTarget | MinHoursShortfallTarget;

/**
 * Recomputes the roster's alert set from current DB state (shift coverage vs. the staffing
 * requirements matrix, and every ACTIVE worker's total assigned hours vs. their contracted
 * minimum) and reconciles it against the persisted `Alert` rows: alerts that no longer apply are
 * deleted, new ones are inserted (unacknowledged), and alerts that still apply are left untouched
 * so their `acknowledged` state survives an edit that doesn't affect them. Every manual roster
 * edit (add/move/remove) runs this inside the SAME transaction as the edit.
 */
export async function recomputeRosterAlerts(
  tx: Prisma.TransactionClient,
  rosterId: number,
): Promise<AlertDto[]> {
  const roster = await tx.roster.findUniqueOrThrow({ where: { id: rosterId } });
  // Company-scoped rostering: coverage targets and min-hours checks are both scoped to the
  // roster's OWN company -- no other company's staffing-requirements matrix or workforce ever
  // feeds into this roster's alerts.
  const [shifts, requirements, activeWorkers, existingAlerts] = await Promise.all([
    tx.shift.findMany({ where: { rosterId }, include: { workers: true } }),
    tx.staffingRequirement.findMany({ where: { companyId: roster.companyId } }),
    tx.worker.findMany({ where: { status: 'ACTIVE', companyId: roster.companyId }, include: { contract: true } }),
    tx.alert.findMany({ where: { rosterId } }),
  ]);

  const requiredCountByCell = new Map<string, number>();
  for (const r of requirements) {
    requiredCountByCell.set(`${r.role}:${r.shift}`, r.requiredCount);
  }

  const targets: AlertTarget[] = [];

  for (const shift of shifts) {
    for (const role of ROLES) {
      const required = requiredCountByCell.get(`${role}:${shift.shiftType}`) ?? 0;
      if (required <= 0) continue;
      const assigned = shift.workers.filter((sw) => sw.role === role).length;
      if (assigned < required) {
        targets.push({
          type: 'UNFILLABLE_SLOT',
          detail: { date: formatDate(shift.date), shift: shift.shiftType, role },
        });
      }
    }
  }

  const hoursByWorkerId = new Map<number, number>();
  for (const shift of shifts) {
    for (const sw of shift.workers) {
      hoursByWorkerId.set(sw.workerId, (hoursByWorkerId.get(sw.workerId) ?? 0) + 8);
    }
  }

  for (const worker of activeWorkers) {
    if (!worker.contract) continue;
    const totalHours = hoursByWorkerId.get(worker.id) ?? 0;
    const deficit = worker.contract.minMonthlyHours - totalHours;
    if (deficit > 0) {
      targets.push({ type: 'MIN_HOURS_SHORTFALL', detail: { workerId: worker.id, deficitHours: deficit } });
    }
  }

  const targetKeys = new Set(targets.map((t) => `${t.type}:${canonicalJson(t.detail)}`));
  const existingKeys = new Set(existingAlerts.map((a) => `${a.type}:${canonicalJson(a.detail)}`));

  const staleIds = existingAlerts
    .filter((a) => !targetKeys.has(`${a.type}:${canonicalJson(a.detail)}`))
    .map((a) => a.id);
  if (staleIds.length > 0) {
    await tx.alert.deleteMany({ where: { id: { in: staleIds } } });
  }

  const newTargets = targets.filter((t) => !existingKeys.has(`${t.type}:${canonicalJson(t.detail)}`));
  if (newTargets.length > 0) {
    await tx.alert.createMany({
      data: newTargets.map((t) => ({
        rosterId,
        type: t.type,
        detail: t.detail,
        acknowledged: false,
      })),
    });
  }

  const finalAlerts = await tx.alert.findMany({ where: { rosterId }, orderBy: { id: 'asc' } });
  return finalAlerts.map(toAlertDto);
}
