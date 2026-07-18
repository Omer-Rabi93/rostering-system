#!/usr/bin/env python3
"""Large-scale benchmark harness for `solve_roster.py` optimization experiments.

Not part of the app's runtime or its pytest suite -- a standalone dev tool for comparing
candidate solver optimizations against each other on a common, deterministic synthetic
problem, independent of the production `TIME_BUDGET_BANDS` tiering (which this script
overrides via `--time-limit`, so every variant gets exactly the same wall-clock budget
regardless of what band its worker count would normally land in -- an apples-to-apples
comparison of "how good a solution does this technique reach in N seconds", not "does it
finish before its production timeout").

Usage:
    python3 solver/scripts/benchmark_scale.py --workers 10000 --time-limit 120 --label baseline

Prints one JSON line to stdout with the timing + solution-quality numbers.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import solve_roster  # noqa: E402

SEED = 20260718

# Role mix + monthly-hours ranges loosely mirroring this repo's seed data / sample CSVs --
# not identical, just plausible enough to stress the solver the way real data does (a handful
# of roles, not one flat role, so the per-role coverage constraints have real structure).
ROLE_MIX: tuple[tuple[str, float, int, int], ...] = (
    ("GENERAL_GUARD", 0.70, 160, 190),
    ("SUPERVISOR", 0.15, 140, 180),
    ("DISPATCHER", 0.10, 120, 160),
    ("TEAM_LEAD", 0.05, 150, 185),
)

DAYS_IN_MONTH = 30
SHIFT_TYPES = ("A", "B", "C")

# Fraction of (worker, date) pairs that get an availability entry at all (Availability v3: a
# missing date means "available every shift" -- most real workers have sparse exclusions, not
# a dense per-date list, so this stays low to mirror that).
AVAILABILITY_ENTRY_RATE = 0.15
# Given a worker has an entry for a date, how many of the 3 shifts they're excluded from
# (1 or 2 -- an entry excluding all 3 shifts would just make that date pointless to include).
EXCLUDED_SHIFT_COUNTS = (1, 2)

# Target requirement sizing: roughly how many workers of a role are expected to cover one
# shift-slot, calibrated to create genuine contention (some understaffing is expected and
# realistic -- see this repo's company-3 diagnosis -- not artificially oversupplied).
COVERAGE_RATIO = 0.045


def build_problem(worker_count: int, seed: int = SEED) -> solve_roster.ProblemInput:
    rng = random.Random(seed)

    days = [f"2026-08-{d:02d}" for d in range(1, DAYS_IN_MONTH + 1)]

    workers: list[solve_roster.WorkerInput] = []
    role_counts: dict[str, int] = {role: 0 for role, *_ in ROLE_MIX}
    for worker_id in range(1, worker_count + 1):
        roll = rng.random()
        cumulative = 0.0
        role, min_h, max_h = ROLE_MIX[-1][0], ROLE_MIX[-1][2], ROLE_MIX[-1][3]
        for candidate_role, share, lo, hi in ROLE_MIX:
            cumulative += share
            if roll <= cumulative:
                role, min_h, max_h = candidate_role, lo, hi
                break
        role_counts[role] += 1

        max_hours = rng.randint(min_h, max_h)
        min_hours = rng.randint(min_h - 20, max_hours - 10)

        availability: dict[str, list[str]] = {}
        for date in days:
            if rng.random() < AVAILABILITY_ENTRY_RATE:
                excluded = rng.sample(SHIFT_TYPES, rng.choice(EXCLUDED_SHIFT_COUNTS))
                allowed = [s for s in SHIFT_TYPES if s not in excluded]
                availability[date] = allowed

        workers.append(
            {
                "id": worker_id,
                "role": role,
                "minMonthlyHours": max(0, min_hours),
                "maxMonthlyHours": max_hours,
                "availability": availability,
            }
        )

    requirements: list[solve_roster.RequirementInput] = []
    for date in days:
        for shift in SHIFT_TYPES:
            for role, count in role_counts.items():
                if count == 0:
                    continue
                required = max(1, round(count * COVERAGE_RATIO))
                requirements.append(
                    {"date": date, "shift": shift, "role": role, "requiredCount": required}
                )

    return {"days": days, "workers": workers, "requirements": requirements}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=10_000)
    parser.add_argument("--time-limit", type=float, default=120.0, help="Wall-clock cap in seconds, overrides TIME_BUDGET_BANDS")
    parser.add_argument("--label", type=str, default="unlabeled")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    problem = build_problem(args.workers, seed=args.seed)

    # Override the production banding for this benchmark run only -- every variant under test
    # gets exactly the same wall-clock budget, regardless of what its own TIME_BUDGET_BANDS says.
    solve_roster.compute_time_budget_seconds = lambda _worker_count: args.time_limit

    # `solve_roster.solve()` calls `sys.exit(1)` (after printing to stderr) when CP-SAT returns
    # neither OPTIMAL nor FEASIBLE within the time budget -- a real, meaningful outcome for this
    # benchmark ("this technique doesn't even find a first solution within the cap"), not a crash
    # to propagate. Catch it here so the harness still prints a comparable report instead of dying.
    start = time.monotonic()
    try:
        result = solve_roster.solve(problem)
    except SystemExit:
        wall_time_s = time.monotonic() - start
        report = {
            "label": args.label,
            "worker_count": args.workers,
            "time_limit_s": args.time_limit,
            "wall_time_s": round(wall_time_s, 2),
            "status": "no_solution_within_time_limit",
        }
        print(json.dumps(report))
        return
    wall_time_s = time.monotonic() - start

    coverage_alerts = [a for a in result["alerts"] if a["type"] == "unfillable_slot"]
    hours_alerts = [a for a in result["alerts"] if a["type"] == "min_hours_shortfall"]

    report = {
        "label": args.label,
        "worker_count": args.workers,
        "time_limit_s": args.time_limit,
        "wall_time_s": round(wall_time_s, 2),
        "status": "ok",
        "assignments": len(result["assignments"]),
        "coverage_shortfall_total": sum(a["missing"] for a in coverage_alerts),
        "coverage_shortfall_slots": len(coverage_alerts),
        "min_hours_deficit_total": sum(a["deficitHours"] for a in hours_alerts),
        "min_hours_shortfall_workers": len(hours_alerts),
        "total_alerts": len(result["alerts"]),
    }
    print(json.dumps(report))


if __name__ == "__main__":
    main()
