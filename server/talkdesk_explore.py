"""
talkdesk_explore.py
Talkdesk Explore API async job runner — port of talkdeskExplore.js

Actual API behaviour (confirmed via testing):
  1. POST /data/reports/{type}/jobs   → create job, get job.id
  2. GET  /data/reports/{type}/jobs/{id} → returns { entries: [...] } directly
     (no separate download step — data is embedded in the poll response)

Usage:
  entries = await run_explore_report("contacts", {"timespan": ..., "timezone": ..., "format": "json"})
  # entries is a list of row dicts
"""

import asyncio
import httpx
from server.talkdesk_auth import get_talkdesk_token

EXPLORE_BASE = "https://api.talkdeskapp.com"
POLL_MAX_ATTEMPTS = 30
POLL_INTERVAL_SEC = 10

_http_client = httpx.AsyncClient()


async def _create_job(token: str, report_type: str, payload: dict) -> str:
    url = f"{EXPLORE_BASE}/data/reports/{report_type}/jobs"
    print(f"📤 [Explore:{report_type}] POST {url}")
    resp = await _http_client.post(
        url,
        json=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    resp.raise_for_status()
    data = resp.json()
    job_id = (data.get("job") or {}).get("id") or data.get("id")
    if not job_id:
        raise ValueError(f"[Explore:{report_type}] Job creation response missing id: {data}")
    print(f"✅ [Explore:{report_type}] Job created: {job_id}")
    return job_id


async def _poll_for_data(token: str, report_type: str, job_id: str) -> list:
    for attempt in range(1, POLL_MAX_ATTEMPTS + 1):
        await asyncio.sleep(POLL_INTERVAL_SEC)

        resp = await _http_client.get(
            f"{EXPLORE_BASE}/data/reports/{report_type}/jobs/{job_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        data = resp.json()

        # If entries array is present, the report is ready
        if isinstance(data.get("entries"), list):
            entries = data["entries"]
            print(f"✅ [Explore:{report_type}] Data ready on poll {attempt}, rows={len(entries)}")
            return entries

        status = (data.get("job") or {}).get("status") or data.get("status") or "pending"
        print(f"🔍 [Explore:{report_type}] Poll {attempt}/{POLL_MAX_ATTEMPTS}: status={status}")
        if status in ("failed", "error"):
            raise RuntimeError(f"[Explore:{report_type}] Job failed: {data}")

    raise TimeoutError(
        f"[Explore:{report_type}] Timed out after {POLL_MAX_ATTEMPTS} polls "
        f"({POLL_MAX_ATTEMPTS * POLL_INTERVAL_SEC}s)"
    )


async def run_explore_report(report_type: str, job_payload: dict, on_progress=None) -> list:
    """
    Run an Explore report end-to-end and return the list of row dicts.

    :param report_type: e.g. "contacts", "adherence"
    :param job_payload: {"timespan": {"from": ..., "to": ...}, "timezone": ..., "format": "json"}
    :param on_progress: optional callback({"stage": ..., ...})
    :returns: list of row dicts
    """
    token = await get_talkdesk_token()
    job_id = await _create_job(token, report_type, job_payload)

    if on_progress:
        on_progress({"stage": "polling", "job_id": job_id})

    entries = await _poll_for_data(token, report_type, job_id)

    if on_progress:
        on_progress({"stage": "done", "count": len(entries)})

    return entries
