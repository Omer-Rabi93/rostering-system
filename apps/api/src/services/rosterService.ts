import type { PrismaClient } from '../db/client.js';
import { NotFoundError, PublishConflictError } from '../errors.js';
import { formatDate, toAlertDto, type AlertDto } from './alertRecompute.js';

export interface ShiftAssignmentDto {
  readonly workerId: number;
  readonly name: string;
  readonly role: string;
}

export interface ShiftDto {
  readonly id: number;
  readonly date: string;
  readonly shiftType: string;
  readonly assignments: readonly ShiftAssignmentDto[];
}

export interface RosterDto {
  readonly id: number;
  readonly month: string;
  readonly status: string;
  readonly generatedAt: string | null;
  readonly publishedAt: string | null;
  readonly shifts: readonly ShiftDto[];
  readonly alerts: readonly AlertDto[];
}

/**
 * Roster read + alert-ack + publish-gate business logic. `PrismaClient` constructor-injected, no
 * Express types. Manual-edit (add/move/remove) logic lives in `ShiftWorkerService` — kept separate
 * because it is mounted under a different route base (`/api/shifts`) — both share the
 * `recomputeRosterAlerts` helper in `alertRecompute.ts`.
 */
export class RosterService {
  constructor(private readonly prisma: PrismaClient) {}

  async getByMonth(companyId: number, month: string): Promise<RosterDto> {
    const roster = await this.prisma.roster.findUnique({
      where: { companyId_month: { companyId, month } },
      include: {
        shifts: {
          include: { workers: { include: { worker: true } } },
          orderBy: [{ date: 'asc' }, { shiftType: 'asc' }],
        },
        alerts: { orderBy: { id: 'asc' } },
      },
    });
    if (!roster) {
      throw new NotFoundError(`Roster for ${month} has not been generated yet`);
    }

    return {
      id: roster.id,
      month: roster.month,
      status: roster.status,
      generatedAt: roster.generatedAt ? roster.generatedAt.toISOString() : null,
      publishedAt: roster.publishedAt ? roster.publishedAt.toISOString() : null,
      shifts: roster.shifts.map((shift) => ({
        id: shift.id,
        date: formatDate(shift.date),
        shiftType: shift.shiftType,
        assignments: shift.workers.map((sw) => ({
          workerId: sw.workerId,
          name: sw.worker.name,
          role: sw.role,
        })),
      })),
      alerts: roster.alerts.map(toAlertDto),
    };
  }

  async ackAlert(rosterId: number, alertId: number): Promise<AlertDto> {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert || alert.rosterId !== rosterId) {
      throw new NotFoundError(`Alert ${alertId} not found on roster ${rosterId}`);
    }
    const updated = await this.prisma.alert.update({
      where: { id: alertId },
      data: { acknowledged: true, acknowledgedAt: new Date() },
    });
    return toAlertDto(updated);
  }

  /**
   * Publish gate: blocked while ANY alert on the roster is unacknowledged. Re-checked from
   * scratch on every call (no stored "already gated" flag), so a regeneration that raises fresh
   * alerts on an already-published month makes the gate live again for the next publish attempt.
   */
  async publish(rosterId: number): Promise<{ status: 'published' }> {
    const roster = await this.prisma.roster.findUnique({ where: { id: rosterId } });
    if (!roster) {
      throw new NotFoundError(`Roster ${rosterId} not found`);
    }

    const unacknowledged = await this.prisma.alert.findMany({
      where: { rosterId, acknowledged: false },
      orderBy: { id: 'asc' },
    });
    if (unacknowledged.length > 0) {
      throw new PublishConflictError(unacknowledged.map((a) => a.id));
    }

    await this.prisma.roster.update({
      where: { id: rosterId },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    return { status: 'published' };
  }
}
