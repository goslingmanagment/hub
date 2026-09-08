"""Offline sensitivity calculation; inputs are the saved read-only SQL outputs.

No network or production writes. Prints a model, not measured HTTP savings.
Run from any directory with Python 3.
"""
from pathlib import Path
import json

evidence = Path(__file__).resolve().parent
rows = []
for line in (evidence / "volume-cross-check.txt").read_text().splitlines():
    cells = [cell.strip() for cell in line.split("|")]
    if len(cells) == 5 and cells[1].isdigit() and cells[2].isdigit():
        rows.append((cells[0], int(cells[1]), int(cells[2])))

baseline = sum(captured - failed for _, captured, failed in rows) / 6
dm_list = 93063 / 6  # list-baseline.txt, kind=dm_conversations
weekly_earnings = 5724 / 7
scenarios = []
for interval in (0.5, 1, 3, 6):
    full = 24 / interval
    for k in (3, 5, 10):
        new_list = dm_list * full / 48 + (48 - full) * (5 * k + 1)
        total = baseline - dm_list + new_list
        scenarios.append({
            "full_interval_hours": interval,
            "assumed_bounded_pages_on_five_larger_accounts": k,
            "ari_pages": 1,
            "list_rows_per_day": round(new_list, 2),
            "fleet_rows_per_day": round(total, 2),
            "modeled_reduction_pct": round(100 * (1 - total / baseline), 2),
        })

print(json.dumps({
    "status": "Conditional model; safe-stop and freshness gates not passed",
    "baseline_nonfailure_observations_per_day": baseline,
    "weekly_earnings_floor_before_additional_refreshes": weekly_earnings,
    "scenarios": scenarios,
    "excluded": ["uncaptured attempts", "retries", "browser traffic", "new event followups"],
}, ensure_ascii=False, indent=2))
