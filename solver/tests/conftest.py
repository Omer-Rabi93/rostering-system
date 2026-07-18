"""Pytest configuration for the solver test suite.

Puts `solver/` on `sys.path` so tests can `import solve_roster` directly
(the module isn't packaged -- it's a single script sidecar, see
`solver/README.md`), and provides small shared fixture builders.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

SOLVER_DIR = Path(__file__).resolve().parent.parent
if str(SOLVER_DIR) not in sys.path:
    sys.path.insert(0, str(SOLVER_DIR))

ROLES = ("GENERAL_GUARD", "SUPERVISOR", "SCREENER")
SHIFT_TYPES = ("A", "B", "C")

# Every fixture-authored shift subset in this test suite is one of these three -- kept as named
# constants so test bodies read as intent ("no nights") rather than a bare list literal.
ALL_SHIFTS = ["A", "B", "C"]
NO_NIGHT_SHIFT = ["A", "B"]


def full_month_availability(days: list[str], shifts: list[str] | None = None) -> dict[str, list[str]]:
    """A worker's date->shifts availability map covering EVERY date in `days`, all carrying the
    same (date-invariant) shift subset -- the fixture-authoring equivalent of the old
    "always available" flat boolean matrix, expressed in Availability v2's date-keyed shape.
    """
    subset = shifts if shifts is not None else ALL_SHIFTS
    return {date: subset[:] for date in days}


def make_worker(
    worker_id: int,
    *,
    role: str = "GENERAL_GUARD",
    min_hours: int = 0,
    max_hours: int = 200,
    availability: dict[str, list[str]] | None = None,
    days: list[str] | None = None,
) -> dict[str, Any]:
    """Builds one solver-problem worker entry. By default the worker is available every shift on
    every date in `days` (mirroring the old fixtures' "always available" baseline) -- pass an
    explicit `availability` map to test date/shift-restricted behavior instead.
    """
    if availability is not None:
        resolved_availability = availability
    elif days is not None:
        resolved_availability = full_month_availability(days)
    else:
        resolved_availability = {}
    return {
        "id": worker_id,
        "role": role,
        "minMonthlyHours": min_hours,
        "maxMonthlyHours": max_hours,
        "availability": resolved_availability,
    }


def full_requirements_matrix(
    days: list[str],
    counts: dict[tuple[str, str], int] | None = None,
) -> list[dict[str, Any]]:
    """Every (day, shift, role) cell, defaulting to 0 -- mirrors the real staffing-requirements
    matrix (one row per role x shift, always present, per the seed script) crossed with every day
    by `engine/problem.ts#buildProblem`. `counts` overrides specific (shift, role) cells for every
    day.
    """
    counts = counts or {}
    return [
        {
            "date": date,
            "shift": shift,
            "role": role,
            "requiredCount": counts.get((shift, role), 0),
        }
        for date in days
        for shift in SHIFT_TYPES
        for role in ROLES
    ]
