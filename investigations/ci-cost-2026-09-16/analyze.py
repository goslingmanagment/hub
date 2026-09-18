"""Reproduce CI runtime attribution from the saved GitHub REST responses.

Job timestamps estimate occupied runner time; they are not an invoice.
Both exact elapsed minutes and per-job rounded minutes are retained.
"""
import collections
import datetime as dt
import json
import math
import pathlib
import statistics

ROOT = pathlib.Path(__file__).resolve().parent
EVIDENCE = ROOT / "evidence"
RATE = 0.006


def seconds(start, end):
    if not start or not end:
        return 0
    return max(0, (dt.datetime.fromisoformat(end.replace("Z", "+00:00"))
                   - dt.datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds())


def aggregate(rows, key):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row[key]].append(row)
    return {
        key: {
            "jobs": len(values),
            "elapsed_minutes": round(sum(x["seconds"] for x in values) / 60, 3),
            "rounded_minutes": sum(x["rounded_minutes"] for x in values),
            "elapsed_cost_estimate": round(sum(x["seconds"] for x in values) / 60 * RATE, 4),
            "rounded_cost_estimate": round(sum(x["rounded_minutes"] for x in values) * RATE, 4),
        }
        for key, values in sorted(groups.items())
    }


runs = json.loads((EVIDENCE / "runs.json").read_text())
jobs = []
for run in runs:
    response = json.loads((EVIDENCE / "jobs" / f"{run['id']}.json").read_text())
    assert response["total_count"] == len(response["jobs"]), "Jobs pagination needed"
    for job in response["jobs"]:
        # Skipped/never assigned jobs do not consume runner minutes.
        elapsed = seconds(job.get("started_at"), job.get("completed_at")) if job.get("runner_id") else 0
        jobs.append({**job, "run_id": run["id"], "workflow": run["name"],
                     "event": run["event"], "date": run["created_at"][:10],
                     "run_conclusion": run["conclusion"], "title": run["display_title"],
                     "head_sha": run["head_sha"], "seconds": elapsed,
                     "rounded_minutes": math.ceil(elapsed / 60)})

assert len({j["id"] for j in jobs}) == len(jobs), "Duplicate job ids"
active = [j for j in jobs if j["seconds"]]
steps = []
for j in active:
    for step in j.get("steps", []):
        elapsed = seconds(step.get("started_at"), step.get("completed_at"))
        if elapsed:
            steps.append({"name": step["name"], "job": j["name"], "date": j["date"],
                          "seconds": elapsed, "rounded_minutes": 0})

summary = {
    "run_count": len(runs), "jobs_returned": len(jobs), "active_jobs": len(active),
    "events": dict(collections.Counter(r["event"] for r in runs)),
    "conclusions": dict(collections.Counter(r["conclusion"] for r in runs)),
    "by_job": aggregate(active, "name"), "by_day": aggregate(active, "date"),
    "by_event": aggregate(active, "event"), "by_run_conclusion": aggregate(active, "run_conclusion"),
    "steps": aggregate(steps, "name"),
}

periods = {"Sep01-12": ("2026-09-01", "2026-09-12"),
           "Sep14": ("2026-09-14", "2026-09-14"), "Sep15": ("2026-09-15", "2026-09-15")}
summary["periods"] = {}
for label, (start, end) in periods.items():
    rs = [r for r in runs if start <= r["created_at"][:10] <= end]
    js = [j for j in active if start <= j["date"] <= end]
    successful = [j for j in js if j["run_conclusion"] == "success"]
    run_minutes = [sum(j["seconds"] for j in js if j["run_id"] == r["id"]) / 60
                   for r in rs if r["name"] == "CI" and r["conclusion"] == "success"]
    summary["periods"][label] = {
        "runs": len(rs), "events": dict(collections.Counter(r["event"] for r in rs)),
        "by_job": aggregate(js, "name"),
        "median_minutes_successful_ci": statistics.median(run_minutes) if run_minutes else None,
        "median_successful_job_minutes": {
            name: statistics.median(j["seconds"] / 60 for j in successful if j["name"] == name)
            for name in sorted({j["name"] for j in successful})},
        "steps_successful": aggregate([s for j in successful for s in [
            {"name": s["name"], "seconds": seconds(s.get("started_at"), s.get("completed_at")),
             "rounded_minutes": 0} for s in j.get("steps", [])]], "name"),
    }

summary["runs_by_cost"] = sorted([
    {"id": r["id"], "title": r["display_title"], "date": r["created_at"][:10],
     "event": r["event"], "head_branch": r["head_branch"], "head_sha": r["head_sha"],
     "conclusion": r["conclusion"], "attempts": r["run_attempt"],
     "minutes": round(sum(j["seconds"] for j in active if j["run_id"] == r["id"]) / 60, 3)}
    for r in runs], key=lambda r: r["minutes"], reverse=True)

(EVIDENCE / "jobs-flat.json").write_text(json.dumps(jobs, indent=2) + "\n")
(ROOT / "analysis.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({k: v for k, v in summary.items() if k not in ["steps", "periods", "runs_by_cost"]}, indent=2))
for label, p in summary["periods"].items():
    print(label, json.dumps({k: v for k, v in p.items() if k not in ["by_job", "steps_successful"]}))
