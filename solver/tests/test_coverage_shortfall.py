"""HARD (a) + its shortfall slack: when the workforce cannot cover a required slot, the model
stays feasible (slack absorbs the deficit) and an `unfillable_slot` alert is raised with the exact
missing count -- coverage is never silently dropped.
"""

from __future__ import annotations

from conftest import full_requirements_matrix, make_worker
from solve_roster import solve


def test_zero_workers_raises_unfillable_slot_for_every_required_cell() -> None:
    days = ["2026-02-01"]
    requirements = full_requirements_matrix(
        days, counts={("A", "GENERAL_GUARD"): 2, ("B", "SUPERVISOR"): 1}
    )

    solution = solve({"days": days, "workers": [], "requirements": requirements})

    assert solution["assignments"] == []
    unfillable = {
        (a["date"], a["shift"], a["role"]): a["missing"]
        for a in solution["alerts"]
        if a["type"] == "unfillable_slot"
    }
    assert unfillable[("2026-02-01", "A", "GENERAL_GUARD")] == 2
    assert unfillable[("2026-02-01", "B", "SUPERVISOR")] == 1


def test_role_mismatch_leaves_a_slot_unfillable_even_with_available_workforce() -> None:
    # A screener slot with only supervisors on staff: the eligible-worker filter in the coverage
    # constraint (`worker.role == role`) means the supervisors can never fill it, regardless of
    # their availability.
    days = ["2026-02-01"]
    workers = [make_worker(1, role="SUPERVISOR", min_hours=0, max_hours=40, days=days)]
    requirements = full_requirements_matrix(days, counts={("A", "SCREENER"): 1})

    solution = solve({"days": days, "workers": workers, "requirements": requirements})

    assert solution["assignments"] == []
    unfillable = [a for a in solution["alerts"] if a["type"] == "unfillable_slot"]
    assert unfillable == [
        {"type": "unfillable_slot", "date": "2026-02-01", "shift": "A", "role": "SCREENER", "missing": 1}
    ]


def test_partial_coverage_reports_only_the_true_shortfall() -> None:
    # 3 required, 1 eligible worker available -> missing=2, not missing=3; the one available
    # worker is actually assigned.
    days = ["2026-02-01"]
    workers = [make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=40, days=days)]
    requirements = full_requirements_matrix(days, counts={("A", "GENERAL_GUARD"): 3})

    solution = solve({"days": days, "workers": workers, "requirements": requirements})

    assert solution["assignments"] == [{"workerId": 1, "date": "2026-02-01", "shift": "A"}]
    unfillable = [a for a in solution["alerts"] if a["type"] == "unfillable_slot"]
    assert unfillable == [
        {"type": "unfillable_slot", "date": "2026-02-01", "shift": "A", "role": "GENERAL_GUARD", "missing": 2}
    ]
