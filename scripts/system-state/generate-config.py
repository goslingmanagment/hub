#!/usr/bin/env python3
"""Drafts the Mac reporter's config (report.py) from what is installed on this Mac.

Reads, changes nothing:
  - the agent gateway's enabled recurring cron jobs (OpenClaw's state database, read-only;
    one-off reminders are left out, and jobs whose key marks them personal);
  - the system's launchd agents in ~/Library/LaunchAgents (labels of the agency's
    prefixes), the loaded ones; the reporter's own job is left out;
  - the desktop app's enabled recurring scheduled tasks (Claude), from every account's
    list;
  - every ~/Backups/<name>/ that holds dated copies.

Prints the draft (or writes it with --out). The real config belongs on the Mac only
(~/.config/agency/system-state.json), never in the repository: titles of jobs name people.
Review it: set "skip": true on what should not be watched, and on a job whose «nothing to
do» means its input is empty (an inbox nobody forwards to) set "skipped": "empty_input"
with "emptyThresholdSeconds". Standard library only.

  python3 generate-config.py [--out PATH] [--reporter mac]
"""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from report import STAMP_DIR, cron_max_gap_seconds, expand, launchd_print  # noqa: E402

LABEL_PREFIXES = ("ru.gosling-agency.", "com.gosling.", "ai.openclaw.")
OWN_LABEL = "ru.gosling-agency.system-state"
#: Cron jobs whose declaration key starts so are a person's own, not the agency's.
PERSONAL_JOB_PREFIXES = ("regimen-",)
#: Jobs whose «nothing to do» is an empty input, and how long that may last.
EMPTY_INPUT_JOBS = {"of-mail": 3 * 86400}
#: What a person reads for the agency's launchd agents (by the label's last part).
LAUNCHD_TITLES = {
    "gateway": "Шлюз агентов OpenClaw",
    "winpc-tunnel": "Туннель шлюза к ПК",
    "campaign-tick": "Найм: кампании объявлений",
    "ari-mirror": "Зеркало контента модели на ПК и в Dropbox",
    "contentops-backup": "Копия базы ContentOps на мак",
    "contentops-tunnel": "Туннель к ContentOps",
    "hub-backup": "Копия базы Hub на мак",
    "ledger-backup": "Копия ledger на мак",
    "ledger-cards": "Ledger: события карт",
    "ledger-mirror": "Ledger: зеркало журнала в /OS",
    "ledger-reports": "Ledger: посты из «Отчётности»",
    "ledger-sheets": "Ledger: таблицы выплат",
    "ledger-sheets-mirror": "Ledger: зеркало в таблицы выплат",
    "mac-backup-push": "Копии мака на сервер",
    "mac-disk-watch": "Место на маке (порог 40 ГБ)",
    "os-people-mirror": "Зеркало людей в карточки /OS",
    "os-tasks-render": "TASKS.md из TaskIndex",
    "taskindex-backup": "Копия TaskIndex на мак",
}
#: Russian titles of the gateway's own jobs whose names are not (by the declaration key's stem).
OPENCLAW_TITLES = {
    "memory-patch-guard": "Сторож памяти агентов",
    "email-important-monitor": "Важные письма в почтах",
    "openclaw-backup-scheduled": "Копия настроек OpenClaw",
    "workspace-files-backup-daily": "Копия файлов агента владельца",
    "chatspace-bundle-watch": "ChatSpace: обновления бандла",
}
CLAUDE_TITLES = {
    "hiring-daily": "Найм: утренний разбор (задача Claude)",
    "customs-daily": "Кастомы: несданные (задача Claude)",
    "ydisk-daily": "Я.Диск: что нового (задача Claude)",
    "traffic-daily": "Трафик за день (задача Claude)",
    "weekly-os-audit": "Аудит /OS (задача Claude)",
}
COPY_TITLES = {
    "agency-hub": ("База Hub", "agency-de"),
    "contentops": ("База ContentOps", "ВМ ContentOps"),
    "ledger": ("База ledger", "agency-de"),
    "taskindex": ("База TaskIndex", "agency-de"),
}


def slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9._-]+", "-", text.lower()).strip("-.")
    return value[:80]


def job_title(name: str, display: Optional[str]) -> str:
    title = (display or name).strip()
    # «Сторож сбоев (каждые 5 мин)»: the period is shown beside it.
    return re.sub(r"\s*\((каждые|каждый)[^)]*\)\s*$", "", title) or title


def duration_seconds(text: Any) -> Optional[int]:
    """«30m», «8h» (also seconds and days) as seconds; None — not such a text."""
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([smhd])\s*", text) if isinstance(text, str) else None
    if match is None:
        return None
    seconds = int(float(match.group(1)) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)])
    return seconds if seconds > 0 else None


def every_period(job: Dict[str, Any], schedule: Dict[str, Any]) -> int:
    """The period of an «every» job. One that paces itself (`pacing.max` beside its schedule) sets its own next run
    anywhere up to that long, whatever `everyMs` says: its period is half of `pacing.max`, so Hub's «silent after twice
    the period and 10 minutes» is the longest wait the job may choose. No readable `pacing.max`: `everyMs`."""
    pacing = job.get("pacing")
    longest = duration_seconds(pacing.get("max")) if isinstance(pacing, dict) else None
    if longest is not None:
        return max(60, longest // 2)
    return max(60, int((schedule.get("everyMs") or 0) / 1000))


def openclaw_jobs(database: Path) -> Dict[str, Any]:
    jobs: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as error:
        return {"database": str(database), "jobs": [], "_error": str(error)}
    try:
        rows = connection.execute(
            "select job_id, declaration_key, name, job_json from cron_jobs where enabled = 1 order by name").fetchall()
    finally:
        connection.close()
    for job_id, declaration, name, job_text in rows:
        job = json.loads(job_text or "{}")
        schedule = job.get("schedule") or {}
        kind = schedule.get("kind")
        if kind == "at":
            continue  # one-off reminders
        stem = re.sub(r"[:-]v\d+$", "", declaration or "")
        if stem.startswith(PERSONAL_JOB_PREFIXES):
            skipped.append({"job": declaration, "why": "личное"})
            continue
        if kind == "every":
            period = every_period(job, schedule)
        elif kind == "cron":
            period = cron_max_gap_seconds(schedule.get("expr", "")) or 86400
        else:
            skipped.append({"job": declaration or job_id, "why": f"расписание {kind} не понять"})
            continue
        key_part = stem or (name if re.fullmatch(r"[A-Za-z0-9._-]+", name) else job_id[:8])
        entry: Dict[str, Any] = {
            "key": f"mac.openclaw.{slug(key_part)}",
            "job": declaration or job_id,
            "title": OPENCLAW_TITLES.get(stem or name) or job_title(name, job.get("displayName")),
            "periodSeconds": period,
        }
        for prefix, threshold in EMPTY_INPUT_JOBS.items():
            if stem.startswith(prefix):
                entry.update({"skipped": "empty_input", "emptyThresholdSeconds": threshold})
        jobs.append(entry)
    out: Dict[str, Any] = {"database": str(database), "jobs": jobs}
    if skipped:
        out["_skipped"] = skipped
    return out


def calendar_period(calendar: Any) -> int:
    entries = calendar if isinstance(calendar, list) else [calendar]
    if any("Day" in entry for entry in entries if isinstance(entry, dict)):
        return 31 * 86400
    if any("Weekday" in entry for entry in entries if isinstance(entry, dict)):
        return 7 * 86400
    times = sorted({entry.get("Hour", 0) * 60 + entry.get("Minute", 0) for entry in entries if isinstance(entry, dict)})
    if len(times) <= 1:
        return 86400
    gaps = [b - a for a, b in zip(times, times[1:])] + [times[0] + 1440 - times[-1]]
    return max(gaps) * 60


def read_plist(path: Path) -> Optional[Dict[str, Any]]:
    """The plist as Python reads it, else as plutil converts it (it forgives what launchd forgives)."""
    try:
        with path.open("rb") as handle:
            return plistlib.load(handle)
    except Exception:  # noqa: BLE001 — an XML error of any kind
        pass
    try:
        done = subprocess.run(["plutil", "-convert", "json", "-o", "-", str(path)], capture_output=True, text=True, timeout=10)
        return json.loads(done.stdout) if done.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def launchd_agents(folder: Path) -> Dict[str, Any]:
    agents: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for path in sorted(folder.glob("*.plist")):
        label = path.stem
        if not label.startswith(LABEL_PREFIXES) or label == OWN_LABEL:
            continue
        plist = read_plist(path)
        if plist is None:
            skipped.append({"label": label, "why": "plist не читается"})
            continue
        if launchd_print(label) is None:
            skipped.append({"label": label, "why": "не загружена в launchd"})
            continue
        keep_alive = bool(plist.get("KeepAlive"))
        if keep_alive:
            period = 300
        elif "StartInterval" in plist:
            period = max(60, int(plist["StartInterval"]))
        elif "StartCalendarInterval" in plist:
            period = calendar_period(plist["StartCalendarInterval"])
        else:
            skipped.append({"label": label, "why": "ни интервала, ни расписания"})
            continue
        last = label.split(".", 2)[-1] if label.startswith("ai.openclaw.") else label.rsplit(".", 1)[-1]
        agents.append({
            "key": f"mac.launchd.{slug(last)}",
            "label": label,
            "title": LAUNCHD_TITLES.get(last, label),
            "periodSeconds": period,
            **({"keepAlive": True} if keep_alive else {}),
        })
    return {"agents": agents, "skipped": skipped}


def claude_tasks(root: Path) -> Dict[str, Any]:
    found: Dict[str, Dict[str, Any]] = {}
    for path in sorted(root.glob("*/*/scheduled-tasks.json")):
        try:
            listed = json.loads(path.read_text(encoding="utf-8")).get("scheduledTasks", [])
        except (OSError, ValueError, AttributeError):
            continue
        for task in listed if isinstance(listed, list) else []:
            if not isinstance(task, dict) or not task.get("enabled") or not task.get("cronExpression"):
                continue  # off, or one-off (fireAt)
            found[task["id"]] = task
    tasks = [{
        "key": f"mac.claude.{slug(task_id)}",
        "task": task_id,
        "title": CLAUDE_TITLES.get(task_id, f"{task_id} (задача Claude)"),
        "periodSeconds": cron_max_gap_seconds(task["cronExpression"]) or 86400,
    } for task_id, task in sorted(found.items())]
    return {"sessions": str(root), "tasks": tasks}


def copies(folder: Path) -> List[Dict[str, Any]]:
    out = []
    for child in sorted(folder.iterdir()) if folder.is_dir() else []:
        if not child.is_dir() or not any(STAMP_DIR.match(item.name) for item in child.iterdir() if item.is_dir()):
            continue
        title, source = COPY_TITLES.get(child.name, (f"Копия {child.name}", "?"))
        out.append({
            "key": f"copy.{slug(child.name)}",
            "title": title,
            "source": source,
            "destination": f"мак: ~/Backups/{child.name}",
            "dir": f"~/Backups/{child.name}",
        })
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Draft the reporter's config from what is installed on this Mac.")
    parser.add_argument("--out", help="write the draft here (default: print it)")
    parser.add_argument("--reporter", default="mac")
    args = parser.parse_args()
    launchd = launchd_agents(expand("~/Library/LaunchAgents"))
    config: Dict[str, Any] = {
        "reporter": args.reporter,
        "place": "mac",
        "hub": {"credentials": "~/.config/hub/credentials"},
        "openclaw": openclaw_jobs(expand("~/.openclaw/state/openclaw.sqlite")),
        "launchd": launchd["agents"],
        "claude": claude_tasks(expand("~/Library/Application Support/Claude/claude-code-sessions")),
        "copies": copies(expand("~/Backups")),
    }
    if launchd["skipped"]:
        config["_launchdSkipped"] = launchd["skipped"]
    text = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        target = expand(args.out)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        os.chmod(target, 0o600)
        counts = {"openclaw": len(config["openclaw"]["jobs"]), "launchd": len(config["launchd"]),
                  "claude": len(config["claude"]["tasks"]), "copies": len(config["copies"])}
        print(json.dumps({"ok": True, "out": str(target), **counts}, ensure_ascii=False))
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
