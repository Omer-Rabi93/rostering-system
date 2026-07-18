import { useState } from 'react';
import type { ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { Badge, EmptyState } from '@rostering/ui';

import '@rostering/ui/styles.css';

import { buildMonthDays } from '../../lib/calendar.js';
import { dayOfWeekName, formatMonthLong } from '../../lib/format.js';
import '../../styles/print.css';
import './publicSchedule.css';
import { usePublicSchedule } from './usePublicSchedule.js';

/**
 * Public, unauthenticated worker-schedule page (`/schedule/:token`). Per
 * `docs/design/ui/README.md`'s "no authenticated chrome on an unauthenticated page" rule, this is
 * a wholly distinct page/layout — it does NOT render inside `components/Layout.tsx` (the
 * authenticated topbar/nav shell) and its only data dependency is `usePublicSchedule`, a plain
 * `fetch` hook with zero reachability into `api/baseApi.ts` or the Redux store. See
 * `PublicSchedulePage.architecture.test.ts` for the automated check of that constraint.
 */
export function PublicSchedulePage(): ReactElement {
  const params = useParams<{ token: string }>();
  const token = params.token ?? '';
  const now = new Date();
  const [month, setMonth] = useState(
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
  );

  const state = usePublicSchedule(token, month);

  if (state.status === 'invalidToken') {
    return (
      <>
        <PublicHeader />
        <main className="page">
          <div className="card schedule-card" style={{ textAlign: 'center' }}>
            <div className="empty-state" style={{ border: 'none' }}>
              <div className="empty-state__icon" aria-hidden="true">
                🔒
              </div>
              <div className="empty-state__title">This link isn&apos;t valid</div>
              <p className="empty-state__body">
                The schedule link you followed doesn&apos;t exist or has been rotated. Ask your
                planner for a fresh link.
              </p>
            </div>
          </div>
        </main>
      </>
    );
  }

  const workerName = state.status === 'loaded' ? state.schedule.name : state.status === 'notPublished' ? state.workerName : null;
  const shiftsByDate = new Map(
    state.status === 'loaded' ? state.schedule.shifts.map((s) => [s.date, s.shiftType]) : [],
  );
  const days = buildMonthDays(month);

  return (
    <>
      <PublicHeader />
      <main className="page">
        <div className="card schedule-card">
          {workerName ? (
            <div className="print-only" style={{ marginBottom: 'var(--space-4)' }}>
              <h1 style={{ fontSize: 'var(--text-3xl)', marginBottom: '2px' }}>{workerName}</h1>
              <p style={{ color: 'var(--color-ink-secondary)' }}>
                Monthly schedule — {formatMonthLong(month)}
              </p>
            </div>
          ) : null}

          <div className="toolbar no-print" style={{ justifyContent: 'space-between' }}>
            <h1 style={{ margin: 0 }}>{workerName ?? (state.status === 'loading' ? 'Loading…' : '')}</h1>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field__label visually-hidden" htmlFor="pub-month">
                Month
              </label>
              <input
                id="pub-month"
                className="field__input"
                type="month"
                value={month}
                onChange={(e) => e.target.value && setMonth(e.target.value)}
              />
            </div>
          </div>

          {state.status === 'loaded' && state.schedule.shifts.length > 0 ? (
            <>
              <div className="schedule-meta no-print">
                <span>
                  Month: <strong>{formatMonthLong(month)}</strong>
                </span>
                <span>
                  Total shifts: <strong>{state.schedule.shifts.length}</strong>
                </span>
                <span>
                  Total hours: <strong>{state.schedule.shifts.length * 8}</strong>
                </span>
              </div>

              <div>
                {days.map((day) => {
                  const shift = shiftsByDate.get(day.date);
                  return (
                    <div className="day-row" key={day.date}>
                      <div className="day-row__date">
                        <span className="dow">{dayOfWeekName(day.date)}</span>
                        {day.label}
                      </div>
                      {shift ? (
                        <Badge kind="shift" value={shift} showHours />
                      ) : (
                        <span style={{ color: 'var(--color-ink-muted)', fontSize: 'var(--text-sm)' }}>Off</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="field__hint no-print" style={{ marginTop: 'var(--space-3)' }}>
                This page shows only this worker&apos;s own shifts for published months — never
                national ID, hourly rate, or any other worker&apos;s assignments.
              </p>
            </>
          ) : state.status === 'notPublished' || (state.status === 'loaded' && state.schedule.shifts.length === 0) ? (
            <EmptyState
              icon={<span aria-hidden="true">🗓️</span>}
              title={`No shifts published for ${formatMonthLong(month)}`}
              body="Nothing to show yet — check back once the schedule for this month is published. This page never shows draft/unpublished rosters."
            />
          ) : null}
        </div>
      </main>
    </>
  );
}

function PublicHeader(): ReactElement {
  return (
    <header className="public-header no-print">
      <span className="public-header__brand">ICTS Rostering — read-only worker schedule (no login)</span>
      <button className="btn btn--secondary btn--sm" type="button" onClick={() => window.print()}>
        🖶 Print
      </button>
    </header>
  );
}
