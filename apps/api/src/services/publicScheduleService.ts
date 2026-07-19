import type { PrismaClient } from '../db/client.js';
import { NotFoundError } from '../errors.js';
import { formatDate } from '../engine/calendar.js';

export interface PublicScheduleShiftDto {
  readonly date: string;
  readonly shiftType: string;
}

export interface PublicScheduleDto {
  readonly name: string;
  readonly month: string;
  readonly shifts: readonly PublicScheduleShiftDto[];
}

/** Generic 404 — identical for "unknown token", "month not published", and "month not generated",
 * so a client can never distinguish an almost-valid token from a wrong one. */
const NOT_FOUND_MESSAGE = 'Not found';

/**
 * Public, unauthenticated worker-schedule read. Returns ONLY that one worker's display name and
 * their own shifts for a PUBLISHED roster month — never `nationalId`, hourly rate, contract data,
 * or any other worker's assignments.
 */
export class PublicScheduleService {
  constructor(private readonly prisma: PrismaClient) {}

  async getSchedule(token: string, month: string | undefined): Promise<PublicScheduleDto> {
    if (!month) {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }

    const worker = await this.prisma.worker.findUnique({ where: { shareToken: token } });
    if (!worker) {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }

    // Company-scoped rostering: the worker's own token already identifies their company, so the
    // roster this token can ever see is that SAME company's roster for `month` -- never another
    // company's roster for the same calendar month.
    const roster = await this.prisma.roster.findUnique({
      where: { companyId_month: { companyId: worker.companyId, month } },
    });
    if (!roster || roster.status !== 'PUBLISHED') {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }

    const assignments = await this.prisma.shiftWorker.findMany({
      where: { workerId: worker.id, shift: { rosterId: roster.id } },
      include: { shift: true },
      orderBy: { shift: { date: 'asc' } },
    });

    return {
      name: worker.name,
      month,
      shifts: assignments.map((a) => ({ date: formatDate(a.shift.date), shiftType: a.shift.shiftType })),
    };
  }
}
