"""Unit tests for `compute_time_budget_seconds` -- a pure function, no CP-SAT/`solve()` invocation
at all, so every band boundary can be asserted cheaply and directly. See that function's own doc
comment in `solve_roster.py` for the banding rationale (heuristic starting point, not a guarantee;
the <=200 band is the proven, unchanged 30s value this repo's other tests already assume).

Mirrors (and is the source of truth `apps/api/tests/engine/timeBudget.test.ts`'s cross-language
parity test spawns this exact interpreter/function against, band-for-band) -- if these bands ever
change, that TS-side test will fail until the two are updated together.
"""

from __future__ import annotations

import pytest

from solve_roster import compute_time_budget_seconds


@pytest.mark.parametrize(
    "worker_count,expected_seconds",
    [
        # Lower edge and interior of the <=200 band: unchanged 30s (the proven, already-tested
        # flat value this app's stated ~50-150-worker org size has always used).
        (0, 30.0),
        (1, 30.0),
        (150, 30.0),
        (200, 30.0),
        # Just above the 200 boundary -> the next band up, not still 30s.
        (201, 600.0),
        (1_000, 600.0),
        (1_001, 600.0),
        (5_000, 600.0),
        (5_001, 1200.0),
        (10_000, 1200.0),
        # Above the stated 10k target: capped at 1800s, not scaled further.
        (10_001, 1800.0),
        (50_000, 1800.0),
    ],
)
def test_band_boundaries(worker_count: int, expected_seconds: float) -> None:
    assert compute_time_budget_seconds(worker_count) == expected_seconds
