"""SOFT: a worker's contracted min-hours target that the available/required work cannot reach
raises a `min_hours_shortfall` alert with the exact hour deficit -- it never blocks the solve.
"""

from __future__ import annotations

from conftest import full_requirements_matrix, make_worker
from solve_roster import solve


def test_worker_under_contracted_min_hours_raises_a_deficit_alert() -> None:
    # Only 2 shifts of demand exist for this worker's role across the whole fixture (1 per day on
    # 2 of the 3 days), so even though they're available every shift, the coverage equality
    # constraint (`sum(eligible) + slack == required`) forbids assigning them anywhere beyond
    # those 2 required slots -- 16h logged against a 100h contracted min.
    days = ["2026-02-01", "2026-02-02", "2026-02-03"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=100, max_hours=200, days=days)
    requirements = full_requirements_matrix(
        days, counts={("A", "GENERAL_GUARD"): 0}
    )
    for row in requirements:
        if row["shift"] == "A" and row["role"] == "GENERAL_GUARD" and row["date"] in (
            "2026-02-01",
            "2026-02-02",
        ):
            row["requiredCount"] = 1

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    assert len(solution["assignments"]) == 2  # 16 contracted hours actually worked
    deficits = [a for a in solution["alerts"] if a["type"] == "min_hours_shortfall"]
    assert deficits == [{"type": "min_hours_shortfall", "workerId": 1, "deficitHours": 84}]


def test_worker_meeting_or_exceeding_min_hours_raises_no_deficit_alert() -> None:
    days = ["2026-02-01"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=8, max_hours=40, days=days)
    requirements = full_requirements_matrix(days, counts={("A", "GENERAL_GUARD"): 1})

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    assert solution["assignments"] == [{"workerId": 1, "date": "2026-02-01", "shift": "A"}]
    assert [a for a in solution["alerts"] if a["type"] == "min_hours_shortfall"] == []
