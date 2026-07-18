#!/usr/bin/env python3
"""Roster scheduling solver sidecar (Google OR-Tools CP-SAT).

Contract: reads a single JSON "problem" document from stdin and writes a
single JSON "solution" document to stdout. No other I/O channel is used --
in particular, no problem data is ever read from argv or the environment
(the Node side spawns this as ``spawn('python3', [scriptPath], {shell:
false})`` with problem data exclusively on stdin -- see
``apps/api/src/engine/problem.ts`` for the JSON shapes this script speaks).

Problem JSON (stdin), produced by ``engine/problem.ts#buildProblem`` (Availability v2 -- date-
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

    A worker is available for a given (date, shift) slot iff ``availability`` has an entry for that
    EXACT calendar date AND that entry's list contains the shift -- a date with no key is the real
    "unavailable that date" state (absence of a `WorkerAvailability` row = unavailable), not a
    default to fall back to "available". There is no weekday/day-of-week reasoning at all -- see
    ``apps/api/src/engine/validator.ts``'s `withinAvailability`, which the solver's variable
    creation below mirrors exactly.

Solution JSON (stdout), consumed by ``engine/problem.ts#parseSolverSolution``::

    {
      "assignments": [{"workerId": 7, "date": "YYYY-MM-DD", "shift": "A"}, ...],
      "alerts": [
        {"type": "unfillable_slot", "date": "...", "shift": "A", "role": "...", "missing": 1},
        {"type": "min_hours_shortfall", "workerId": 7, "deficitHours": 12}
      ]
    }

CP-SAT model (per ``docs/design/rostering-system-design.html``, "Core
Algorithms & Validation" section):

- Boolean decision variables ``x[worker, date, shift]`` are created ONLY where
  the worker's date-keyed availability lists that exact calendar date and
  shift -- impossible assignments never become variables, which keeps the
  model as small as the workforce's actual availability.
- HARD (a): role coverage per (date, shift, role), with an integer shortfall
  slack absorbing any deficit so the model is never INFEASIBLE.
- HARD (b): at most 2 shifts per worker per calendar date.
- HARD (c): ``8 * sum(x) <= maxMonthlyHours`` per worker.
- SOFT: a min-hours deficit slack per worker (``8 * sum(x) + deficit >=
  minMonthlyHours``), and a fairness "load" term (percentage of each
  worker's own ``maxMonthlyHours`` they end up scheduled for) whose max-min
  spread is minimized.
- Objective (lexicographic via weights): ``10_000 * coverage_shortfall +
  100 * min_hours_deficit + 1 * (load_max - load_min)``.
- Determinism: fixed seed 42, a single search worker, and a 30s time limit --
  the same problem JSON always produces the same solution JSON.
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
MAX_TIME_IN_SECONDS = 30.0


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


def solve(problem: ProblemInput) -> dict[str, Any]:
    days = problem["days"]
    workers = problem["workers"]
    requirements = problem["requirements"]

    model = cp_model.CpModel()

    # Decision variables x[(worker_id, date, shift)] -- created ONLY where the worker's date-keyed
    # availability allows it: `shift in availability.get(date, [])`. A date absent from the map is
    # the real "unavailable that date" state -- `.get(date, [])` defaults to an empty list (not a
    # fabricated "always available"), so no variable is ever created for a date the worker has no
    # entry for. There is no weekday reasoning at all (Availability v2).
    x: dict[tuple[int, str, str], cp_model.IntVar] = {}
    for worker in workers:
        worker_id = worker["id"]
        availability = worker["availability"]
        for date in days:
            shifts_for_date = availability.get(date, [])
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

    # HARD (c): max monthly hours. SOFT: min-hours shortfall slack. Fairness "load": each worker's
    # scheduled hours as a percentage of their own contracted max (0..100), so workers on
    # different contracts are comparable; the objective minimizes the spread between the
    # most-loaded and least-loaded worker.
    deficit: dict[int, cp_model.IntVar] = {}
    load: dict[int, cp_model.IntVar] = {}
    for worker in workers:
        worker_id = worker["id"]
        min_hours = worker["minMonthlyHours"]
        max_hours = worker["maxMonthlyHours"]

        worker_vars = [v for (owner, _date, _shift), v in x.items() if owner == worker_id]
        total_shifts = sum(worker_vars) if worker_vars else 0

        model.add(SHIFT_HOURS * total_shifts <= max_hours)

        deficit_var = model.new_int_var(0, min_hours, f"deficit_{worker_id}")
        deficit[worker_id] = deficit_var
        model.add(SHIFT_HOURS * total_shifts + deficit_var >= min_hours)

        load_var = model.new_int_var(0, 100, f"load_{worker_id}")
        if max_hours > 0:
            hours_var = model.new_int_var(0, max_hours, f"hours_{worker_id}")
            model.add(hours_var == SHIFT_HOURS * total_shifts)
            model.add_division_equality(load_var, hours_var * 100, max_hours)
        else:
            # A zero-hour contract can never be "loaded" -- pin load to 0 rather than divide by
            # zero (this worker also contributes no hours by construction of the hard constraint
            # above, so 0 is exact, not just a safe default).
            model.add(load_var == 0)
        load[worker_id] = load_var

    load_max = model.new_int_var(0, 100, "load_max")
    load_min = model.new_int_var(0, 100, "load_min")
    if load:
        model.add_max_equality(load_max, list(load.values()))
        model.add_min_equality(load_min, list(load.values()))
    else:
        model.add(load_max == 0)
        model.add(load_min == 0)

    # Lexicographic objective via weights: coverage >> min-hours >> even distribution.
    model.minimize(
        10_000 * sum(short.values())
        + 100 * sum(deficit.values())
        + 1 * (load_max - load_min)
    )

    solver = cp_model.CpSolver()
    solver.parameters.random_seed = RANDOM_SEED
    solver.parameters.num_search_workers = NUM_SEARCH_WORKERS
    solver.parameters.max_time_in_seconds = MAX_TIME_IN_SECONDS
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
            f"solver did not find a solution within {MAX_TIME_IN_SECONDS}s "
            f"(status: {solver.status_name(status)})",
            file=sys.stderr,
        )
        sys.exit(1)

    assignments = [
        {"workerId": worker_id, "date": date, "shift": shift}
        for (worker_id, date, shift), var in x.items()
        if solver.value(var) == 1
    ]
    # Deterministic, stable output ordering: the `x` dict's insertion order already follows
    # workers -> days -> shifts, but sort explicitly so output order never depends on Python's
    # dict/set iteration incidentals.
    assignments.sort(key=lambda a: (a["workerId"], a["date"], a["shift"]))

    unfillable_alerts = [
        {"type": "unfillable_slot", "date": date, "shift": shift, "role": role, "missing": solver.value(var)}
        for (date, shift, role), var in short.items()
        if solver.value(var) > 0
    ]
    unfillable_alerts.sort(key=lambda a: (a["date"], a["shift"], a["role"]))

    min_hours_alerts = [
        {"type": "min_hours_shortfall", "workerId": worker_id, "deficitHours": solver.value(var)}
        for worker_id, var in deficit.items()
        if solver.value(var) > 0
    ]
    min_hours_alerts.sort(key=lambda a: a["workerId"])

    return {"assignments": assignments, "alerts": unfillable_alerts + min_hours_alerts}


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
