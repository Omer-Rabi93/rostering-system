"""Fairness objective term: among interchangeable workers, the solver minimizes the spread
between the most-loaded and least-loaded worker (`load_max - load_min`, weight 1 -- the lowest
priority in the lexicographic objective, but still enforced whenever it's free to do so without
hurting coverage or min-hours).
"""

from __future__ import annotations

from conftest import full_requirements_matrix, make_worker
from solve_roster import solve


def test_evenly_divisible_demand_splits_exactly_evenly_across_identical_workers() -> None:
    # 28 days (non-leap Feb), 1 GENERAL_GUARD required per day on shift A = 28 shifts of demand.
    # 4 identical, interchangeable workers, evenly divisible (28 / 4 = 7 shifts each) -- nothing
    # about coverage or min-hours favors any particular split, so the fairness term should drive
    # the solver to the exactly-even one.
    days = [f"2026-02-{day:02d}" for day in range(1, 29)]
    workers = [make_worker(w, role="GENERAL_GUARD", min_hours=0, max_hours=80, days=days) for w in range(1, 5)]
    requirements = full_requirements_matrix(days, counts={("A", "GENERAL_GUARD"): 1})

    solution = solve({"days": days, "workers": workers, "requirements": requirements})

    assert solution["alerts"] == []
    shift_counts = {w: 0 for w in range(1, 5)}
    for assignment in solution["assignments"]:
        shift_counts[assignment["workerId"]] += 1

    assert sum(shift_counts.values()) == 28
    assert max(shift_counts.values()) - min(shift_counts.values()) <= 1
    # With clean divisibility (28 / 4), the exactly-even split is achievable and should be found.
    assert set(shift_counts.values()) == {7}


def test_uneven_demand_still_minimizes_the_max_min_load_gap() -> None:
    # 15 days of demand (not evenly divisible by 4 workers) -- the achievable minimum spread is a
    # 1-shift difference (some workers get 4, others 3: 15 = 4+4+4+3), not an even split.
    days = [f"2026-02-{day:02d}" for day in range(1, 16)]
    workers = [make_worker(w, role="GENERAL_GUARD", min_hours=0, max_hours=80, days=days) for w in range(1, 5)]
    requirements = full_requirements_matrix(days, counts={("A", "GENERAL_GUARD"): 1})

    solution = solve({"days": days, "workers": workers, "requirements": requirements})

    assert solution["alerts"] == []
    shift_counts = {w: 0 for w in range(1, 5)}
    for assignment in solution["assignments"]:
        shift_counts[assignment["workerId"]] += 1

    assert sum(shift_counts.values()) == 15
    assert max(shift_counts.values()) - min(shift_counts.values()) <= 1
