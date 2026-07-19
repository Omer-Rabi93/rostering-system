#!/usr/bin/env python3
"""Roster scheduling solver sidecar (Google OR-Tools CP-SAT).

Contract: reads a single JSON "problem" document from stdin and writes a
single JSON "solution" document to stdout. No other I/O channel is used --
in particular, no problem data is ever read from argv or the environment
(the Node side spawns this as ``spawn('python3', [scriptPath], {shell:
false})`` with problem data exclusively on stdin -- see
``apps/api/src/engine/problem.ts`` for the JSON shapes this script speaks).

Problem JSON (stdin), produced by ``engine/problem.ts#buildProblem`` (Availability v3 -- date-
specific worker availability, per calendar date of the month being rostered)::

    {
      "days": ["YYYY-MM-DD", ...],                    # every day of the month, in order
      "workers": [
        {"id": 7, "role": "SUPERVISOR", "minMonthlyHours": 100, "maxMonthlyHours": 180,
         "availability": {"YYYY-MM-DD": ["A", "C"], ...}}   # sparse date -> shift-subset map
      ],
      "requirements": [
        {"date": "YYYY-MM-DD", "shift": "A", "role": "SUPERVISOR", "requiredCount": 2}, ...
      ]                                                 # already crossed with every day
    }

    ``availability`` here already carries the shifts a worker CAN work (the excluded/cannot-work
    shifts a `WorkerAvailability` row actually stores in the DB are inverted into this
    included/available form one layer up, before this JSON is ever built -- see
    ``apps/api/src/services/rosterGenerationService.ts``'s `loadMonthAvailabilityRows` and
    `@rostering/shared`'s `computeAvailableShifts`; this script never sees a raw excluded value).

    A worker is available for a given (date, shift) slot iff EITHER ``availability`` has no entry
    at all for that EXACT calendar date (Availability v3: a missing date means available for every
    shift) OR it has an entry and that entry's list contains the shift. There is no weekday/day-of-
    week reasoning at all -- see ``apps/api/src/engine/validator.ts``'s `withinAvailability`, which
    the solver's variable creation below mirrors exactly (including its own identical
    missing-date-means-available default).

Solution JSON (stdout), consumed by ``engine/problem.ts#parseSolverSolution``::

    {
      "assignments": [{"workerId": 7, "date": "YYYY-MM-DD", "shift": "A"}, ...],
      "alerts": [
        {"type": "unfillable_slot", "date": "...", "shift": "A", "role": "...", "missing": 1},
        {"type": "min_hours_shortfall", "workerId": 7, "deficitHours": 12}
      ]
    }

Three-stage model (per ``docs/design/rostering-system-design.html``, "Core Algorithms &
Validation" section -- revised from a single-phase CP-SAT model after a scale investigation,
see "Why not CP-SAT for hours" below). Loosely called "two-phase" (CP-SAT, then Python
post-processing) since stages 2 and 3 both run entirely outside CP-SAT, back to back:

STAGE 1 (CP-SAT, ``_solve_coverage``) -- coverage only:
- Boolean decision variables ``x[worker, date, shift]`` are created ONLY where
  the worker's date-keyed availability lists that exact calendar date and
  shift -- impossible assignments never become variables, which keeps the
  model as small as the workforce's actual availability.
- HARD (a): role coverage per (date, shift, role), with an integer shortfall
  slack absorbing any deficit so the model is never INFEASIBLE.
- HARD (b): at most 2 shifts per worker per calendar date.
- HARD (c): ``8 * sum(x) <= maxMonthlyHours`` per worker.
- Objective: ``10_000 * coverage_shortfall`` -- ONLY coverage. No min-hours or fairness term at
  all, so CP-SAT has no reason to prefer one feasible "who fills this slot" assignment over
  another; it just needs to find ANY assignment satisfying the hard constraints. The resulting
  hours distribution across workers is therefore arbitrary and is NOT meant to be read as
  meaningful until stages 2 and 3 have run.

STAGE 2 (plain Python, ``_reduce_min_hours_deficit``) -- min-hours, entirely outside CP-SAT:
- A bounded, deterministic local search that reassigns individual (date, shift) SLOTS from
  workers with slack above their own minMonthlyHours to workers below theirs, largest deficit
  first, WITHIN the same role. Same swap-legality guards as stage 3 below.

STAGE 3 (plain Python, ``_improve_fairness``) -- load balancing, entirely outside CP-SAT:
- A bounded, deterministic local search that reassigns individual (date, shift) SLOTS from
  over-loaded to under-loaded workers WITHIN the same role. Coverage is invariant by
  construction -- a swap only changes WHO fills an already-decided slot, never whether it's
  filled -- and a swap is only ever made when it doesn't exceed the receiving worker's
  maxMonthlyHours or drop the giving worker's hours below their own minMonthlyHours, so neither
  of stage 1's hard guarantees nor stage 2's min-hours reduction can be worsened by this pass,
  only the (lowest-priority) load spread can improve.

Why not CP-SAT for hours -- this used to be a single CP-SAT model with BOTH a min-hours deficit
term AND a fairness "load" term (each worker's scheduled hours as a % of their own contracted
max) whose company-wide max-min spread was minimized via ``add_max_equality``/``add_min_equality``
over every worker's load variable. A scale investigation (~10,000-worker synthetic benchmark)
found the fairness formulation catastrophic past roughly 1,000 workers: CP-SAT would find ZERO
solutions (status UNKNOWN) within any tested time budget, even many minutes. Isolated testing
proved this wasn't about HOW the max/min spread was expressed (exact ``add_max_equality`` vs.
plain inequalities), whether it used integer division or a linear reformulation, or whether it
was even part of the objective at all -- the mere presence of O(worker-count) constraints all
referencing two shared "hub" variables was enough on its own to break CP-SAT's ability to find
any incumbent. Moving fairness entirely outside CP-SAT (stage 3) fixed that -- but a follow-up
scaling-curve benchmark (10 through 2,000 workers) then found the SAME class of problem one
priority level up: the min-hours deficit SUM in the stage-1 objective, despite having no shared
hub IntVar at all, still couples every same-role worker into one large symmetric optimization
(CP-SAT has to decide who "wins" each scarce shift to minimize total deficit across potentially
thousands of interchangeable workers) -- wall time jumped from ~2s at 200 workers to ~120s
(timeout) at 500, and 2,000 workers found no solution at all within 120s. Removing the deficit
term from the objective (coverage-only, proven in isolation) solved 2,000 workers in ~8s.
Min-hours deficit reduction therefore also moved out of CP-SAT (stage 2), leaving CP-SAT with
ONLY the coverage objective, which has no such coupling (each requirement's slack is independent
of every other's). Stage 1 alone (proven in isolation) finds a solution in single-digit seconds
even at 10,000+ workers, something the original single-phase model never did past ~1,000.
Stages 2 and 3 are heuristic, not exact -- this trades away CP-SAT's provable-optimal-deficit
guarantee for an answer that actually arrives at scale; see each stage's own doc comment.

Determinism: fixed seed 42, a single search worker, and a fixed time limit for stage 1 (see
``compute_time_budget_seconds`` below) -- the same problem JSON always produces the same solution
JSON. The time limit is BANDED by workforce size (30s/600s/600s/1200s/1800s), not a single global
constant -- CP-SAT needs meaningfully more search time as the problem grows (originally tuned for
~50-150 workers, this repo's stated org size), but a fixed per-size time limit is still fully
deterministic: the same problem JSON always has the same ``len(workers)``, so it always gets the
same budget and therefore the same outcome. Stages 2 and 3 are themselves deterministic by
construction (see ``_reduce_min_hours_deficit`` and ``_improve_fairness``'s own doc comments) --
no randomness, no reliance on Python `set`/`dict` iteration order for anything correctness-sensitive,
only explicit sorts with deterministic
tie-breaks.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, TypedDict

from ortools.sat.python import cp_model

SHIFT_TYPES: tuple[str, str, str] = ("A", "B", "C")
SHIFT_HOURS = 8

RANDOM_SEED = 42
NUM_SEARCH_WORKERS = 1

# Banded/tiered CP-SAT time budget, in seconds, indexed by (upper bound on) active workforce
# size. A DELIBERATE, BINDING design choice (see the module docstring's "Determinism" bullet):
# rather than one flat global constant, the budget scales with the size of the problem CP-SAT is
# actually being asked to search, while staying fully deterministic (the same problem JSON always
# has the same worker count, so it always lands in the same band). The <=200 band is UNCHANGED
# from this repo's original flat 30s constant -- that's the proven, already-tested case (this
# app's stated org size is ~50-150 workers), so it must not regress. Bands above that are a
# reasonable, defensible STARTING POINT, not a guarantee: CP-SAT's real solve time on a given
# problem depends heavily on availability density and staffing tightness (how constrained the
# coverage requirements are relative to who's actually available), not on workforce size alone --
# two companies with the same worker count can solve at very different speeds. Capped at 1800s
# (30 min) above 10,000 workers rather than scaling further: a company genuinely beyond this
# system's stated 10k-worker target degrades gracefully to an honest UNKNOWN/timeout at some
# point, which is a correct outcome, not a bug, rather than a job that could run forever.
TIME_BUDGET_BANDS: tuple[tuple[int, float], ...] = (
    (200, 30.0),
    (1_000, 600.0),
    (5_000, 600.0),
    (10_000, 1200.0),
)
TIME_BUDGET_ABOVE_MAX_WORKERS = 1800.0


def compute_time_budget_seconds(worker_count: int) -> float:
    """Pure function: active-workforce size -> CP-SAT ``max_time_in_seconds`` budget. No solver
    invocation, so this is cheap to unit-test directly for every band boundary (see
    ``solver/tests/test_time_budget.py``) without paying for a real CP-SAT solve.
    """
    for max_workers, budget_seconds in TIME_BUDGET_BANDS:
        if worker_count <= max_workers:
            return budget_seconds
    return TIME_BUDGET_ABOVE_MAX_WORKERS


class WorkerInput(TypedDict):
    id: int
    role: str
    minMonthlyHours: int
    maxMonthlyHours: int
    availability: dict[str, list[str]]


class RequirementInput(TypedDict):
    date: str
    shift: str
    role: str
    requiredCount: int


class ProblemInput(TypedDict):
    days: list[str]
    workers: list[WorkerInput]
    requirements: list[RequirementInput]


def _solve_coverage(
    days: list[str],
    workers: list[WorkerInput],
    requirements: list[RequirementInput],
    time_budget_seconds: float,
) -> tuple[set[tuple[int, str, str]], dict[tuple[str, str, str], int]]:
    """Phase 1: CP-SAT solves HARD(a) coverage, HARD(b) 2-shifts/day, and HARD(c) max-hours --
    deliberately with NO min-hours or fairness/load-spread term in the objective at all (see the
    module docstring's "Why two phases" section). The objective is coverage shortfall ONLY, so
    CP-SAT has no reason to prefer one feasible assignment of "who fills this slot" over another --
    it just needs to find ANY assignment satisfying the hard constraints, which is what keeps this
    fast at scale (proven: coverage-only solves 2,000 workers in ~8s; adding a min-hours deficit
    sum to the objective, even with no fairness term at all, made the same model take 120s+ at 500
    workers and fail outright at 2,000 -- summing a deficit term across every same-role worker
    couples them into one large symmetric optimization exactly like the fairness hub variables did,
    just via the objective instead of an explicit shared IntVar).

    Returns `(assignments, short_values)` as plain Python values -- the CP-SAT model and solver are
    fully done by the time this returns, nothing here is an IntVar. `short_values` is keyed the
    same as the old in-model `short` dict. Since CP-SAT no longer optimizes for hours at all, the
    resulting hours distribution is ARBITRARY (an artifact of CP-SAT's internal search order, not
    a preference) -- `_reduce_min_hours_deficit` and `_improve_fairness` are what turn this into an
    actually good distribution, entirely outside CP-SAT.
    """
    model = cp_model.CpModel()

    # Decision variables x[(worker_id, date, shift)] -- created for every shift the worker is
    # available for: `shift in availability.get(date, SHIFT_TYPES)`. Availability v3: a date absent
    # from the map is the real "available every shift" state -- `.get(date, SHIFT_TYPES)` defaults
    # to every shift (not a fabricated "always unavailable"), so a variable IS created for a date
    # the worker has no entry for, one per shift. There is no weekday reasoning at all.
    x: dict[tuple[int, str, str], cp_model.IntVar] = {}
    for worker in workers:
        worker_id = worker["id"]
        availability = worker["availability"]
        for date in days:
            shifts_for_date = availability.get(date, SHIFT_TYPES)
            for shift in SHIFT_TYPES:
                if shift in shifts_for_date:
                    x[(worker_id, date, shift)] = model.new_bool_var(
                        f"x_{worker_id}_{date}_{shift}"
                    )

    # HARD (a): role coverage per (date, shift, role), with a shortfall slack absorbing any
    # deficit so the model is always feasible -- an understaffed slot raises an alert instead of
    # making the whole problem unsolvable.
    short: dict[tuple[str, str, str], cp_model.IntVar] = {}
    for requirement in requirements:
        date, shift, role, required = (
            requirement["date"],
            requirement["shift"],
            requirement["role"],
            requirement["requiredCount"],
        )
        slack = model.new_int_var(0, required, f"short_{date}_{shift}_{role}")
        short[(date, shift, role)] = slack
        eligible = [
            x[(worker["id"], date, shift)]
            for worker in workers
            if worker["role"] == role and (worker["id"], date, shift) in x
        ]
        model.add(sum(eligible) + slack == required)

    # HARD (b): at most 2 shifts per worker per calendar date. Midnight-spanning shifts (e.g. C on
    # day N then A on day N+1) are unaffected -- this constraint only sums variables that share the
    # same calendar `date` key, never across a day boundary.
    for worker in workers:
        worker_id = worker["id"]
        for date in days:
            day_vars = [
                x[(worker_id, date, shift)] for shift in SHIFT_TYPES if (worker_id, date, shift) in x
            ]
            if day_vars:
                model.add(sum(day_vars) <= 2)

    # HARD (c): max monthly hours. No min-hours term here at all -- see `_reduce_min_hours_deficit`.
    for worker in workers:
        worker_id = worker["id"]
        max_hours = worker["maxMonthlyHours"]

        worker_vars = [v for (owner, _date, _shift), v in x.items() if owner == worker_id]
        total_shifts = sum(worker_vars) if worker_vars else 0

        model.add(SHIFT_HOURS * total_shifts <= max_hours)

    # Objective: coverage shortfall only. No min-hours or fairness term here -- see
    # `_reduce_min_hours_deficit` and `_improve_fairness`.
    model.minimize(10_000 * sum(short.values()))

    solver = cp_model.CpSolver()
    solver.parameters.random_seed = RANDOM_SEED
    solver.parameters.num_search_workers = NUM_SEARCH_WORKERS
    solver.parameters.max_time_in_seconds = time_budget_seconds
    status = solver.solve(model)  # never INFEASIBLE -- slacks absorb any shortage

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # The model is built so a feasible solution should always exist (slack variables absorb
        # any coverage/min-hours shortage rather than making the model infeasible -- see the
        # objective above), but on a large enough problem `max_time_in_seconds` can still expire
        # before the solver has recorded ANY solution (status UNKNOWN). Calling solver.value(...)
        # below with no solution recorded raises an opaque IndexError deep inside OR-Tools --
        # fail loudly and specifically instead, so the caller (Node's runSolver.ts) gets a clear
        # SolverProcessError via the non-zero exit code, not a crash indistinguishable from any
        # other bug.
        print(
            f"solver did not find a solution within {time_budget_seconds}s "
            f"(status: {solver.status_name(status)})",
            file=sys.stderr,
        )
        sys.exit(1)

    assignments = {key for key, var in x.items() if solver.value(var) == 1}
    short_values = {key: solver.value(var) for key, var in short.items()}

    return assignments, short_values


def _load_percent(hours: int, max_hours: int) -> int:
    """Same semantics as the old CP-SAT `add_division_equality(load_var, hours*100, max_hours)`:
    integer floor division, 0 for a zero-hour contract (which can never be "loaded" -- such a
    worker also always has `hours == 0` by construction of phase 1's HARD(c) constraint, so 0 is
    exact here, not just a safe default)."""
    if max_hours <= 0:
        return 0
    return (hours * 100) // max_hours


def _is_available(worker: WorkerInput, date: str, shift: str) -> bool:
    return shift in worker["availability"].get(date, SHIFT_TYPES)


# Bound on how many swap attempts `_reduce_min_hours_deficit` makes per role PER ROUND -- same
# rationale as `MAX_FAIRNESS_SWAP_ATTEMPTS_PER_WORKER` below.
MAX_DEFICIT_SWAP_ATTEMPTS_PER_WORKER = 20

# Bounded outer round count for `_reduce_min_hours_deficit` -- same re-sort-each-round rationale as
# `MAX_FAIRNESS_ROUNDS` below (a giver's or a deficient worker's true rank can drift as other pairs
# swap within the same round).
MAX_DEFICIT_ROUNDS = 20


def _reduce_min_hours_deficit(
    workers: list[WorkerInput],
    assignments: set[tuple[int, str, str]],
    hours_by_worker: dict[int, int],
) -> None:
    """Phase 1.5 (plain Python, between CP-SAT coverage and the fairness pass): mutates
    `assignments` and `hours_by_worker` IN PLACE. A bounded, deterministic local search that
    reassigns individual (date, shift) slots from workers with slack above their own
    minMonthlyHours to workers below theirs -- largest deficit first, within the same role.

    Why this exists: phase 1 CP-SAT (`_solve_coverage`) no longer optimizes for hours at all (see
    the module docstring's "Why two phases" section and `_solve_coverage`'s own doc comment) -- it
    just finds SOME feasible assignment satisfying coverage, 2-shifts/day, and max-hours, with no
    preference for who ends up with how many hours. Left alone, that initial distribution can be
    wildly uneven (some workers maxed out, others at zero) purely as an artifact of CP-SAT's
    internal search order. This pass runs BEFORE `_improve_fairness` so the higher-priority
    min-hours objective (weight 100, vs. fairness's weight 1) gets first claim on which
    reassignments happen.

    Invariants preserved (same reasoning as `_improve_fairness`): coverage is invariant by
    construction (a swap only changes WHO fills an already-decided slot), and a swap is only made
    if it doesn't drop the giving worker's hours below their own minMonthlyHours or push the
    receiving worker's hours above their own maxMonthlyHours -- so this pass can only ever reduce
    total deficit, never introduce or worsen one, and `_improve_fairness` afterward can only narrow
    load-percent spread among whatever's left, never re-introduce a deficit this pass already
    closed.

    This is a heuristic, not an exact optimum -- unlike the old single-phase CP-SAT model, this
    pass does NOT guarantee the provably minimal total deficit, only a greedy reduction of it. That
    trade-off is deliberate: proving optimality for this term is exactly what broke CP-SAT's
    scalability (see `_solve_coverage`'s doc comment), and a good greedy answer at 10,000 workers is
    strictly better than an exact answer that never arrives.
    """
    workers_by_role: dict[str, list[int]] = {}
    for worker in workers:
        workers_by_role.setdefault(worker["role"], []).append(worker["id"])

    worker_by_id = {worker["id"]: worker for worker in workers}

    assigned_slots: dict[int, list[tuple[str, str]]] = {}
    day_shift_count: dict[tuple[int, str], int] = {}
    for (worker_id, date, shift) in assignments:
        assigned_slots.setdefault(worker_id, []).append((date, shift))
        key = (worker_id, date)
        day_shift_count[key] = day_shift_count.get(key, 0) + 1
    for worker_id in assigned_slots:
        assigned_slots[worker_id].sort()

    for role in sorted(workers_by_role):
        role_ids = sorted(workers_by_role[role])
        if len(role_ids) < 2:
            continue  # no one to give/receive from -- nothing this pass can do

        min_hours_by_id = {wid: worker_by_id[wid]["minMonthlyHours"] for wid in role_ids}
        max_hours_by_id = {wid: worker_by_id[wid]["maxMonthlyHours"] for wid in role_ids}

        for _round in range(MAX_DEFICIT_ROUNDS):
            # Freshly recomputed every round from the CURRENT `hours_by_worker` -- same
            # re-sort-each-round rationale as `_improve_fairness`.
            deficient = sorted(
                (wid for wid in role_ids if hours_by_worker[wid] < min_hours_by_id[wid]),
                key=lambda wid: (-(min_hours_by_id[wid] - hours_by_worker[wid]), wid),
            )
            if not deficient:
                break  # every worker in this role already meets their own min-hours

            # Most-slack-first: workers furthest above their own min-hours are asked to give up a
            # slot before workers with little or no slack, minimizing the chance of "spending" a
            # giver who's only barely above their own minimum.
            givers = sorted(
                role_ids,
                key=lambda wid: (-(hours_by_worker[wid] - min_hours_by_id[wid]), wid),
            )

            hi = 0
            lo = 0
            max_attempts = len(role_ids) * MAX_DEFICIT_SWAP_ATTEMPTS_PER_WORKER
            attempts = 0
            swaps_this_round = 0
            while hi < len(givers) and lo < len(deficient) and attempts < max_attempts:
                attempts += 1
                most = givers[hi]
                least = deficient[lo]
                if most == least:
                    hi += 1
                    continue
                if hours_by_worker[least] >= min_hours_by_id[least]:
                    # Already closed (an earlier swap this round filled it) -- move on.
                    lo += 1
                    continue

                moved = False
                for (date, shift) in assigned_slots.get(most, []):
                    if not _is_available(worker_by_id[least], date, shift):
                        continue
                    if day_shift_count.get((least, date), 0) >= 2:
                        continue
                    new_least_hours = hours_by_worker[least] + SHIFT_HOURS
                    if new_least_hours > max_hours_by_id[least]:
                        continue
                    new_most_hours = hours_by_worker[most] - SHIFT_HOURS
                    if new_most_hours < min_hours_by_id[most]:
                        continue

                    assignments.discard((most, date, shift))
                    assignments.add((least, date, shift))
                    assigned_slots[most].remove((date, shift))
                    assigned_slots.setdefault(least, []).append((date, shift))
                    day_shift_count[(most, date)] = day_shift_count.get((most, date), 0) - 1
                    day_shift_count[(least, date)] = day_shift_count.get((least, date), 0) + 1
                    hours_by_worker[most] = new_most_hours
                    hours_by_worker[least] = new_least_hours
                    moved = True
                    swaps_this_round += 1
                    if hours_by_worker[least] >= min_hours_by_id[least]:
                        lo += 1
                    break

                if not moved:
                    # This giver has nothing left to legally offer this deficient worker --
                    # advance to the next giver against the same deficient worker.
                    hi += 1

            if swaps_this_round == 0:
                break  # converged -- a fresh pass found nothing left worth moving


# Bound on how many swap attempts `_improve_fairness` makes per role PER ROUND, scaled by that
# role's own worker count -- large enough to meaningfully narrow the load spread on a real-sized
# role, small enough to keep this pass fast (each attempt is cheap, O(1) amortized plus a short
# scan of one worker's own assigned slots) even on a company with several thousand workers in one
# role.
MAX_FAIRNESS_SWAP_ATTEMPTS_PER_WORKER = 20

# A single static sweep over the over/under-loaded queues can leave residual imbalance: as swaps
# happen, a worker's TRUE current rank can drift away from the fixed sort order the sweep is
# still walking (e.g. a worker who started mid-pack can end up an extreme after OTHER workers'
# swaps, but a one-pass sweep never revisits it). Re-sorting from scratch every round fixes this
# -- bounded by `MAX_FAIRNESS_ROUNDS` (and by a round naturally converging early once it makes
# zero swaps) so this stays cheap even for a large role: each round is O(role_size log role_size)
# for the re-sort, and re-sorting a few thousand elements a bounded number of times is trivial
# next to the CP-SAT solve it follows.
MAX_FAIRNESS_ROUNDS = 20


def _improve_fairness(
    workers: list[WorkerInput],
    assignments: set[tuple[int, str, str]],
    hours_by_worker: dict[int, int],
) -> None:
    """Phase 2: mutates `assignments` and `hours_by_worker` IN PLACE. A bounded, deterministic
    local search that reassigns individual (date, shift) slots from over-loaded to under-loaded
    workers WITHIN the same role, narrowing the max-min load-percent spread -- replacing the old
    CP-SAT `add_max_equality`/`add_min_equality` formulation entirely (see the module docstring's
    "Why two phases" section for why that formulation doesn't scale past ~1,000 workers).

    Invariants preserved (never worsened, only fairness can improve):
    - Coverage is invariant by construction: a swap only changes WHO fills an already-decided
      slot, never whether it's filled, so phase 1's `short_values` stay valid unchanged.
    - A swap is only made if it doesn't drop the giving worker's hours below their own
      `minMonthlyHours` (so no worker's min-hours deficit can be introduced or worsened by this
      pass) and doesn't push the receiving worker's hours above their own `maxMonthlyHours` (so
      HARD(c) stays satisfied for every worker throughout).

    Determinism: every ordering this function's outcome depends on is an explicit `sorted(...)`
    with a deterministic tie-break (worker id, or the `(date, shift)` string tuple itself) --
    nothing here relies on Python `set`/`dict` iteration order, which is NOT guaranteed stable
    across process runs for keys involving strings (hash randomization). The same problem JSON
    (and same phase-1 CP-SAT output, itself already deterministic) always produces the same
    phase-2 result.
    """
    workers_by_role: dict[str, list[int]] = {}
    for worker in workers:
        workers_by_role.setdefault(worker["role"], []).append(worker["id"])

    worker_by_id = {worker["id"]: worker for worker in workers}

    assigned_slots: dict[int, list[tuple[str, str]]] = {}
    day_shift_count: dict[tuple[int, str], int] = {}
    for (worker_id, date, shift) in assignments:
        assigned_slots.setdefault(worker_id, []).append((date, shift))
        key = (worker_id, date)
        day_shift_count[key] = day_shift_count.get(key, 0) + 1
    for worker_id in assigned_slots:
        assigned_slots[worker_id].sort()

    for role in sorted(workers_by_role):
        role_ids = sorted(workers_by_role[role])
        if len(role_ids) < 2:
            continue  # no one to compare against -- 0 spread, same as before

        max_hours_by_id = {wid: worker_by_id[wid]["maxMonthlyHours"] for wid in role_ids}
        min_hours_by_id = {wid: worker_by_id[wid]["minMonthlyHours"] for wid in role_ids}

        for _round in range(MAX_FAIRNESS_ROUNDS):
            # Two deterministic queues, freshly re-sorted from the CURRENT `hours_by_worker` at
            # the start of every round -- most-loaded first, least-loaded first, tie-broken by
            # worker id. Re-sorting each round (rather than once) is what lets a worker who
            # drifted to a new extreme, because of swaps involving OTHER workers earlier in this
            # same round, actually get picked up -- a single static sweep can leave residual
            # imbalance a later round would have caught.
            overloaded = sorted(
                role_ids,
                key=lambda wid: (-_load_percent(hours_by_worker[wid], max_hours_by_id[wid]), wid),
            )
            underloaded = sorted(
                role_ids,
                key=lambda wid: (_load_percent(hours_by_worker[wid], max_hours_by_id[wid]), wid),
            )

            hi = 0
            lo = 0
            max_attempts = len(role_ids) * MAX_FAIRNESS_SWAP_ATTEMPTS_PER_WORKER
            attempts = 0
            swaps_this_round = 0
            while hi < len(overloaded) and lo < len(underloaded) and attempts < max_attempts:
                attempts += 1
                most = overloaded[hi]
                least = underloaded[lo]
                if most == least:
                    lo += 1
                    continue

                most_load = _load_percent(hours_by_worker[most], max_hours_by_id[most])
                least_load = _load_percent(hours_by_worker[least], max_hours_by_id[least])
                if most_load - least_load <= 1:
                    # This pair is already as close as an 8-hour-shift-granularity swap can get --
                    # every worker still ahead of `lo` in `underloaded` has a load >= `least`'s by
                    # construction, so no remaining pair under this `hi` can do meaningfully
                    # better THIS round (a later round's fresh sort may still find more to do).
                    hi += 1
                    continue

                moved = False
                for (date, shift) in assigned_slots.get(most, []):
                    if not _is_available(worker_by_id[least], date, shift):
                        continue
                    if day_shift_count.get((least, date), 0) >= 2:
                        continue
                    new_least_hours = hours_by_worker[least] + SHIFT_HOURS
                    if new_least_hours > max_hours_by_id[least]:
                        continue
                    new_most_hours = hours_by_worker[most] - SHIFT_HOURS
                    if new_most_hours < min_hours_by_id[most]:
                        continue

                    assignments.discard((most, date, shift))
                    assignments.add((least, date, shift))
                    assigned_slots[most].remove((date, shift))
                    assigned_slots.setdefault(least, []).append((date, shift))
                    day_shift_count[(most, date)] = day_shift_count.get((most, date), 0) - 1
                    day_shift_count[(least, date)] = day_shift_count.get((least, date), 0) + 1
                    hours_by_worker[most] = new_most_hours
                    hours_by_worker[least] = new_least_hours
                    moved = True
                    swaps_this_round += 1
                    break

                if not moved:
                    # No legal slot to move from this most-loaded worker to this least-loaded one
                    # -- advance to the next most-loaded worker against the same least-loaded one.
                    hi += 1
                # else: stay on the same (hi, lo) pair -- there may be room for another swap
                # between them before either stops being the extreme worth pursuing.

            if swaps_this_round == 0:
                break  # converged -- a fresh sort found nothing left worth moving


def solve(problem: ProblemInput) -> dict[str, Any]:
    days = problem["days"]
    workers = problem["workers"]
    requirements = problem["requirements"]

    # Computed straight from `len(workers)` -- already in hand, no wire-format change needed to
    # get this value here (the problem JSON already carries the full `workers` array). See
    # `compute_time_budget_seconds`'s doc comment for the banding rationale.
    time_budget_seconds = compute_time_budget_seconds(len(workers))

    assignments, short_values = _solve_coverage(days, workers, requirements, time_budget_seconds)

    hours_by_worker = {worker["id"]: 0 for worker in workers}
    for (worker_id, _date, _shift) in assignments:
        hours_by_worker[worker_id] += SHIFT_HOURS

    _reduce_min_hours_deficit(workers, assignments, hours_by_worker)
    _improve_fairness(workers, assignments, hours_by_worker)

    # Deficit is derived fresh from `hours_by_worker` AFTER phase 2 (rather than reusing phase 1's
    # CP-SAT-computed deficit values), since a swap can only ever REDUCE a worker's deficit (by
    # construction of `_improve_fairness`'s own guard, never introduce or worsen one) -- deficit is
    # simply `max(0, min_hours - actual_hours)` by definition, so recomputing it directly is both
    # simpler and provably correct rather than tracking incremental changes through the swap loop.
    deficit_values = {
        worker["id"]: max(0, worker["minMonthlyHours"] - hours_by_worker[worker["id"]])
        for worker in workers
    }

    assignments_list = [
        {"workerId": worker_id, "date": date, "shift": shift}
        for (worker_id, date, shift) in sorted(assignments)
    ]

    unfillable_alerts = [
        {"type": "unfillable_slot", "date": date, "shift": shift, "role": role, "missing": value}
        for (date, shift, role), value in short_values.items()
        if value > 0
    ]
    unfillable_alerts.sort(key=lambda a: (a["date"], a["shift"], a["role"]))

    min_hours_alerts = [
        {"type": "min_hours_shortfall", "workerId": worker_id, "deficitHours": value}
        for worker_id, value in deficit_values.items()
        if value > 0
    ]
    min_hours_alerts.sort(key=lambda a: a["workerId"])

    return {"assignments": assignments_list, "alerts": unfillable_alerts + min_hours_alerts}


def main() -> None:
    raw_input = sys.stdin.read()

    # Test-only escape hatch for the Node<->Python contract test (apps/api/tests/): emits
    # deliberately malformed stdout so the Node side's Zod-validated `parseSolverSolution` can be
    # proven to reject it before anything is ever persisted. Gated behind an explicit env var that
    # only test harnesses set -- never derived from stdin/problem data, and never set in
    # production (the roster-generation job never sets this variable).
    garbage_mode = os.environ.get("SOLVER_TEST_EMIT_GARBAGE")
    if garbage_mode == "invalid_json":
        sys.stdout.write("this is not valid JSON {{{")
        return
    if garbage_mode == "invalid_schema":
        # Valid JSON, but violates the solver-solution contract (wrong type for `assignments`,
        # plus an unexpected extra key the `.strict()` Zod schema must reject).
        json.dump({"assignments": "not-an-array", "alerts": [], "unexpectedField": True}, sys.stdout)
        return

    problem: ProblemInput = json.loads(raw_input) if raw_input.strip() else {
        "days": [],
        "workers": [],
        "requirements": [],
    }
    solution = solve(problem)
    json.dump(solution, sys.stdout)


if __name__ == "__main__":
    main()
