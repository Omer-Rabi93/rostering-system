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


def test_fairness_is_scoped_per_role_not_company_wide() -> None:
    # A scale investigation found the OLD company-wide fairness formulation (comparing every
    # worker in the whole company against a single shared max/min, regardless of role) had a
    # latent correctness bug independent of performance: whichever role happened to have the
    # widest NATURAL spread (from availability/contract constraints, not lack of solver effort)
    # would silently absorb the entire fairness budget, leaving every other role's fairness
    # effectively unenforced. This test proves the current per-role scoping fixes that: 2
    # GENERAL_GUARD workers with clean, evenly-divisible demand split evenly, REGARDLESS of a
    # SCREENER whose own spread is forced wide by an availability restriction that has nothing to
    # do with the guards at all.
    days = [f"2026-02-{day:02d}" for day in range(1, 11)]  # 10 days

    guards = [make_worker(w, role="GENERAL_GUARD", min_hours=0, max_hours=80, days=days) for w in (1, 2)]
    # Screener 3 is available every day; screener 4 is available only on day 1 -- their own
    # spread is forced wide no matter what the solver does, independent of any fairness pressure.
    screeners = [
        make_worker(3, role="SCREENER", min_hours=0, max_hours=80, days=days),
        make_worker(4, role="SCREENER", min_hours=0, max_hours=80, availability={days[0]: ["A"]}),
    ]
    workers = guards + screeners

    requirements = full_requirements_matrix(
        days, counts={("A", "GENERAL_GUARD"): 1, ("A", "SCREENER"): 1}
    )

    solution = solve({"days": days, "workers": workers, "requirements": requirements})

    assert solution["alerts"] == []
    shift_counts: dict[int, int] = {w["id"]: 0 for w in workers}
    for assignment in solution["assignments"]:
        shift_counts[assignment["workerId"]] += 1

    # 10 days of demand split evenly across the 2 guards, regardless of the screeners' own spread.
    assert shift_counts[1] == shift_counts[2] == 5
    # The screeners' spread is unavoidable (worker 4 can only ever cover day 1) -- not the point of
    # this test, just confirming coverage itself is unaffected.
    assert shift_counts[3] + shift_counts[4] == 10


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
