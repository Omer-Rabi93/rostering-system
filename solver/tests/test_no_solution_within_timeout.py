"""When CP-SAT's `max_time_in_seconds` cap expires before it has recorded ANY solution (status
UNKNOWN), `solver.value(...)` raises an opaque IndexError deep inside OR-Tools if called
unguarded. Reproduced against a real (if artificially time-starved) large problem -- exercises the
actual code path, not a mock -- and asserts `solve()` fails loudly and specifically (SystemExit)
instead of crashing with that IndexError.
"""

from __future__ import annotations

import pytest

import solve_roster
from conftest import make_worker


def test_time_budget_exhausted_before_any_solution_fails_cleanly_not_with_indexerror(monkeypatch) -> None:
    monkeypatch.setattr(solve_roster, "MAX_TIME_IN_SECONDS", 0.001)

    days = [f"2026-08-{d:02d}" for d in range(1, 29)]
    workers = [
        make_worker(i, role="GENERAL_GUARD", min_hours=0, max_hours=200, days=days)
        for i in range(1, 301)
    ]
    requirements = [
        {"date": date, "shift": shift, "role": "GENERAL_GUARD", "requiredCount": 30}
        for date in days
        for shift in ("A", "B", "C")
    ]

    with pytest.raises(SystemExit) as excinfo:
        solve_roster.solve({"days": days, "workers": workers, "requirements": requirements})

    assert excinfo.value.code == 1
