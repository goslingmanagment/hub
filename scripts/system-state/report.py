#!/usr/bin/env python3
"""The Mac's reporter for Hub's «Система → Состояние» (ecosystem plan, package P).

Reads, changes nothing, and sends Hub one batch of routines and one of copies:
  - launchd agents of the system (labels and titles from the config; state from
    `launchctl print`: running or not, runs since load, the last exit code; the
    run's time from its log's mtime when launchd gives none);
  - the agent gateway's cron jobs (OpenClaw), from its own state database opened
    read-only: the latest run receipts of each job (ok, error, skipped);
  - the desktop app's scheduled tasks (Claude): the newest dispatch any account
    of the app recorded. How a task ended is not written anywhere it can be read
    reliably, so they are sent with no result: «итог не виден»;
  - copies: the newest dated folder under each configured ~/Backups/<name>/ and
    its manifest.json when there is one.

What to report (keys, Russian titles, periods, thresholds of empty input) lives
in a config file on the Mac, ~/.config/agency/system-state.json by default; it
is drafted by generate-config.py from what is installed. The key comes from the
credentials file the config names (HUB_AGENT_KEY, HUB_BASE_URL); it is never
printed. Prints one JSON line. Standard library only, Python 3.9+.

  python3 report.py [--config PATH] [--credentials PATH] [--hub-url URL] [--dry-run]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

VERSION = "1"
DEFAULT_CONFIG = "~/.config/agency/system-state.json"
UTC = dt.timezone.utc
STAMP_DIR = re.compile(r"^\d{8}T\d{6}Z$")


def now_utc() -> dt.datetime:
    return dt.datetime.now(UTC).replace(microsecond=0)


def iso(moment: Optional[dt.datetime]) -> Optional[str]:
    return None if moment is None else moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def from_ms(value: Any) -> Optional[dt.datetime]:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return dt.datetime.fromtimestamp(value / 1000, UTC).replace(microsecond=0)


def expand(path: str) -> Path:
    return Path(os.path.expanduser(path))


def cut(text: Optional[str], limit: int = 200) -> Optional[str]:
    if not text:
        return None
    line = " ".join(str(text).split())
    return line if len(line) <= limit else line[: limit - 1] + "…"


# ── Cron: the longest gap of a schedule (as Hub counts it) ───────────────────

def _cron_field(field: str, low: int, high: int) -> Optional[set]:
    values = set()
    for part in field.split(","):
        rng, _, step_text = part.partition("/")
        try:
            step = int(step_text) if step_text else 1
            if rng == "*":
                a, b = low, high
            elif "-" in rng:
                a_text, b_text = rng.split("-", 1)
                a, b = int(a_text), int(b_text)
            else:
                a = int(rng)
                b = high if step_text else a
        except ValueError:
            return None
        if step < 1 or a < low or b > high or a > b:
            return None
        values.update(range(a, b + 1, step))
    return values


def cron_max_gap_seconds(expression: str) -> Optional[int]:
    """The longest gap between two runs of a five-field cron, over 62 days; at most 40 days."""
    fields = expression.split()
    if len(fields) != 5:
        return None
    minutes = _cron_field(fields[0], 0, 59)
    hours = _cron_field(fields[1], 0, 23)
    days = _cron_field(fields[2], 1, 31)
    months = _cron_field(fields[3], 1, 12)
    weekdays = _cron_field(re.sub(r"\b7\b", "0", fields[4]), 0, 6)
    if None in (minutes, hours, days, months, weekdays):
        return None
    any_day, any_weekday = fields[2] == "*", fields[4] == "*"
    start = dt.datetime(2026, 1, 5, tzinfo=UTC)  # a Monday
    fires: List[float] = []
    for offset in range(62):
        day = start + dt.timedelta(days=offset)
        if day.month not in months:
            continue
        day_ok, weekday_ok = day.day in days, (day.isoweekday() % 7) in weekdays
        if not ((day_ok and weekday_ok) if (any_day or any_weekday) else (day_ok or weekday_ok)):
            continue
        for hour in sorted(hours):
            for minute in sorted(minutes):
                fires.append(day.timestamp() + hour * 3600 + minute * 60)
    if len(fires) < 2:
        return 40 * 86400
    gap = max(b - a for a, b in zip(fires, fires[1:]))
    return int(min(max(60, gap), 40 * 86400))


# ── launchd ──────────────────────────────────────────────────────────────────

def launchd_print(label: str) -> Optional[str]:
    try:
        done = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout if done.returncode == 0 else None


def _field(text: str, name: str) -> Optional[str]:
    match = re.search(rf"^\s*{re.escape(name)} = (.+)$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def mtime(path: Optional[str]) -> Optional[dt.datetime]:
    if not path:
        return None
    try:
        return dt.datetime.fromtimestamp(expand(path).stat().st_mtime, UTC).replace(microsecond=0)
    except OSError:
        return None


def launchd_routine(entry: Dict[str, Any], at: dt.datetime) -> Dict[str, Any]:
    base = routine_base(entry)
    text = launchd_print(entry["label"])
    if text is None:
        return {**base, "lastRunAt": None, "lastSuccessAt": None, "lastResult": "failed", "detail": "Не загружена в launchd"}
    state = _field(text, "state") or ""
    runs = _field(text, "runs")
    last_exit = _field(text, "last exit code")
    if entry.get("keepAlive"):
        running = state == "running"
        return {
            **base,
            "lastRunAt": iso(at),
            "lastSuccessAt": iso(at) if running else None,
            "lastResult": "ok" if running else "failed",
            "detail": None if running else f"Не запущена; последний выход: {last_exit or 'нет'}",
            "runCount": int(runs) if runs and runs.isdigit() else None,
        }
    logs = [mtime(_field(text, "stdout path")), mtime(_field(text, "stderr path"))]
    seen = max((moment for moment in logs if moment is not None), default=None)
    result: Optional[str]
    detail = None
    if last_exit is None or last_exit.startswith("("):
        result = None  # never exited since it was loaded
    elif last_exit == "0":
        result = "ok"
    else:
        result = "failed"
        detail = f"Код выхода {last_exit}"
    return {
        **base,
        "lastRunAt": iso(seen),
        "lastSuccessAt": None,
        "lastResult": result,
        "detail": detail,
        "runCount": int(runs) if runs and runs.isdigit() else None,
    }


# ── OpenClaw ─────────────────────────────────────────────────────────────────

STATUS = {"ok": "ok", "error": "failed", "interrupted": "failed", "skipped": "skipped"}


def openclaw_routines(section: Dict[str, Any], at: dt.datetime) -> List[Dict[str, Any]]:
    jobs = [entry for entry in section.get("jobs", []) if not entry.get("skip")]
    if not jobs:
        return []
    database = expand(section.get("database", "~/.openclaw/state/openclaw.sqlite"))
    out: List[Dict[str, Any]] = []
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as error:
        return [{**routine_base(entry), "lastRunAt": None, "lastSuccessAt": None, "lastResult": None,
                 "detail": cut(f"База OpenClaw не читается: {error}")} for entry in jobs]
    try:
        rows = connection.execute(
            "select job_id, store_key, declaration_key, name, enabled, state_json from cron_jobs").fetchall()
        for entry in jobs:
            wanted = entry["job"]
            row = next((r for r in rows if r[2] == wanted or r[0] == wanted), None)
            base = routine_base(entry)
            if row is None:
                out.append({**base, "lastRunAt": None, "lastSuccessAt": None, "lastResult": "failed",
                            "detail": "Такой задачи нет в OpenClaw"})
                continue
            job_id, store_key, _, _, enabled, state_text = row
            state = json.loads(state_text or "{}")
            receipts = connection.execute(
                "select status, started_at_ms, finished_at_ms, error_text from cron_run_receipts "
                "where job_id = ? and store_key = ? and status not in ('running', 'superseded') "
                "order by started_at_ms desc limit 64", (job_id, store_key)).fetchall()
            out.append(openclaw_routine(entry, base, bool(enabled), state, receipts))
    finally:
        connection.close()
    return out


def openclaw_routine(entry: Dict[str, Any], base: Dict[str, Any], enabled: bool, state: Dict[str, Any], receipts: list) -> Dict[str, Any]:
    skipped_means = entry.get("skipped", "skipped")
    result_of = lambda status: skipped_means if status == "skipped" else STATUS.get(status)  # noqa: E731
    last_run = last_ok = None
    result = None
    detail = None
    if receipts:
        status, started, finished, error_text = receipts[0]
        last_run = from_ms(finished or started)
        result = result_of(status)
        if result == "failed":
            detail = cut(f"Ошибка: {error_text}" if error_text else "Ошибка")
        ok = next((r for r in receipts if r[0] == "ok"), None)
        last_ok = from_ms(ok[2] or ok[1]) if ok else None
    else:
        last_run = from_ms(state.get("lastRunAtMs"))
        result = result_of(state.get("lastRunStatus") or "") if last_run else None
    if last_ok is None and state.get("lastRunStatus") == "ok":
        last_ok = from_ms(state.get("lastRunAtMs"))
    failed_runs = 0
    for receipt in receipts:
        if STATUS.get(receipt[0]) != "failed":
            break
        failed_runs += 1
    if not receipts:
        failed_runs = int(state.get("consecutiveErrors") or 0)
    empty_since = None
    if result == "empty_input":
        for receipt in receipts:
            if receipt[0] != "skipped":
                break
            empty_since = from_ms(receipt[1])
    if not enabled:
        detail = "Выключена в OpenClaw" + (f". {detail}" if detail else "")
    return {
        **base,
        "lastRunAt": iso(last_run),
        "lastSuccessAt": iso(last_ok),
        "lastResult": result,
        "detail": detail,
        "failedRuns": failed_runs,
        "emptySince": iso(empty_since),
    }


# ── Claude scheduled tasks ───────────────────────────────────────────────────

def claude_routines(section: Dict[str, Any]) -> List[Dict[str, Any]]:
    tasks = [entry for entry in section.get("tasks", []) if not entry.get("skip")]
    if not tasks:
        return []
    root = expand(section.get("sessions", "~/Library/Application Support/Claude/claude-code-sessions"))
    newest: Dict[str, dt.datetime] = {}
    enabled: Dict[str, bool] = {}
    for path in root.glob("*/*/scheduled-tasks.json"):
        try:
            listed = json.loads(path.read_text(encoding="utf-8")).get("scheduledTasks", [])
        except (OSError, ValueError, AttributeError):
            continue
        for task in listed if isinstance(listed, list) else []:
            if not isinstance(task, dict) or not task.get("id"):
                continue
            enabled[task["id"]] = enabled.get(task["id"], False) or bool(task.get("enabled"))
            ran = task.get("lastRunAt")
            if isinstance(ran, str):
                try:
                    moment = dt.datetime.fromisoformat(ran.replace("Z", "+00:00")).replace(microsecond=0)
                except ValueError:
                    continue
                if task["id"] not in newest or moment > newest[task["id"]]:
                    newest[task["id"]] = moment
    out = []
    for entry in tasks:
        task_id = entry["task"]
        detail = "Запускает приложение Claude, пока оно открыто; итог запуска отсюда не виден"
        if task_id not in enabled:
            detail = "Задачи нет в приложении Claude"
        elif not enabled[task_id]:
            detail = "Задача выключена в приложении Claude"
        out.append({**routine_base(entry), "lastRunAt": iso(newest.get(task_id)), "lastSuccessAt": None,
                    "lastResult": None, "detail": detail})
    return out


# ── Copies ───────────────────────────────────────────────────────────────────

def parse_moment(text: Any) -> Optional[dt.datetime]:
    if not isinstance(text, str) or not text:
        return None
    if STAMP_DIR.match(text):
        return dt.datetime.strptime(text, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    value = text.strip().replace(" ", "T", 1)
    value = re.sub(r"([+-]\d\d)$", r"\1:00", value).replace("Z", "+00:00")
    try:
        moment = dt.datetime.fromisoformat(re.sub(r"\.(\d{6})\d*", r".\1", value))
    except ValueError:
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=UTC)).astimezone(UTC).replace(microsecond=0)


def copy_report(entry: Dict[str, Any]) -> Dict[str, Any]:
    folder = expand(entry["dir"])
    dated = sorted(child.name for child in folder.iterdir() if child.is_dir() and STAMP_DIR.match(child.name)) if folder.is_dir() else []
    report: Dict[str, Any] = {
        "key": entry["key"], "title": entry["title"], "source": entry["source"], "destination": entry["destination"],
        "takenAt": None, "bytes": None, "kept": len(dated), "detail": None,
    }
    if not dated:
        report["detail"] = "Папка пуста" if folder.is_dir() else "Папки нет"
        return report
    newest = folder / dated[-1]
    manifest: Dict[str, Any] = {}
    try:
        manifest = json.loads((newest / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {}
    taken = parse_moment(manifest.get("snapshotAt")) or parse_moment(manifest.get("createdAt")) or parse_moment(dated[-1])
    size = manifest.get("bytes")
    if not isinstance(size, int):
        size = sum(item.stat().st_size for item in newest.rglob("*") if item.is_file())
    report.update({"takenAt": iso(taken), "bytes": size})
    if isinstance(manifest.get("tables"), int):
        with_data = manifest.get("tablesWithData")
        report["detail"] = f"Таблиц: {manifest['tables']}" + (f", с данными {with_data}" if isinstance(with_data, int) else "")
    return report


# ── The batch ────────────────────────────────────────────────────────────────

def routine_base(entry: Dict[str, Any]) -> Dict[str, Any]:
    base = {"key": entry["key"], "place": entry.get("place", "mac"), "title": entry["title"], "periodSeconds": int(entry["periodSeconds"])}
    if entry.get("emptyThresholdSeconds"):
        base["emptyThresholdSeconds"] = int(entry["emptyThresholdSeconds"])
    return base


def read_credentials(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip().removeprefix("export ").strip()] = value.strip().strip("'\"")
    return values


def send(base_url: str, key: str, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="PUT",
        headers={"authorization": f"Bearer {key}", "content-type": "application/json", "user-agent": f"system-state-reporter/{VERSION}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return {"ok": True, **json.loads(response.read().decode("utf-8"))}
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(text).get("message")
        except ValueError:
            message = text[:200]
        return {"ok": False, "status": error.code, "message": cut(message, 300)}
    except (urllib.error.URLError, OSError) as error:
        return {"ok": False, "status": None, "message": cut(str(error), 300)}


def build(config: Dict[str, Any], at: dt.datetime) -> Dict[str, Any]:
    reporter, place = config.get("reporter", "mac"), config.get("place", "mac")
    routines: List[Dict[str, Any]] = []
    routines += openclaw_routines(config.get("openclaw", {}), at)
    routines += [launchd_routine(entry, at) for entry in config.get("launchd", []) if not entry.get("skip")]
    routines += claude_routines(config.get("claude", {}))
    copies = [copy_report(entry) for entry in config.get("copies", []) if not entry.get("skip")]
    stamp = iso(at)
    return {
        "routines": {"reporter": reporter, "place": place, "readAt": stamp, "version": VERSION, "routines": routines},
        "copies": {"reporter": reporter, "place": place, "readAt": stamp, "version": VERSION, "copies": copies},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Send this Mac's routines and copies to Hub («Состояние»).")
    parser.add_argument("--config", default=os.environ.get("SYSTEM_STATE_CONFIG", DEFAULT_CONFIG))
    parser.add_argument("--credentials", help="a file with HUB_AGENT_KEY and HUB_BASE_URL (overrides the config's)")
    parser.add_argument("--hub-url", help="Hub's base URL (overrides the credentials')")
    parser.add_argument("--dry-run", action="store_true", help="print the two batches, send nothing")
    args = parser.parse_args()

    config = json.loads(expand(args.config).read_text(encoding="utf-8"))
    at = now_utc()
    batches = build(config, at)
    summary = {"reporter": batches["routines"]["reporter"], "routines": len(batches["routines"]["routines"]),
               "copies": len(batches["copies"]["copies"]), "readAt": iso(at)}
    if args.dry_run:
        print(json.dumps(batches, ensure_ascii=False, indent=1))
        return 0

    credentials = read_credentials(expand(args.credentials or config.get("hub", {}).get("credentials", "~/.config/hub/credentials")))
    key = credentials.get("HUB_AGENT_KEY", "")
    base_url = args.hub_url or config.get("hub", {}).get("url") or credentials.get("HUB_BASE_URL", "")
    if not key or not base_url:
        print(json.dumps({"ok": False, **summary, "message": "no HUB_AGENT_KEY or Hub URL"}, ensure_ascii=False))
        return 2
    routines = send(base_url, key, "/api/v1/agent/system/routines", batches["routines"])
    copies = send(base_url, key, "/api/v1/agent/system/copies", batches["copies"])
    ok = routines.get("ok") and copies.get("ok")
    print(json.dumps({
        "ok": bool(ok), **summary,
        "sent": {"routines": {k: routines.get(k) for k in ("ok", "accepted", "retired", "status", "message") if k in routines},
                 "copies": {k: copies.get(k) for k in ("ok", "accepted", "retired", "status", "message") if k in copies}},
    }, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
