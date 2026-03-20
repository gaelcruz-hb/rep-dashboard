"""
app.py
FastAPI server — port of server.js for Databricks Apps deployment.

Serves:
  - React SPA (dist/) as static files
  - All /api/* endpoints (Salesforce + Talkdesk data)
"""

import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# Load .env from the server/ directory (local dev)
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from server.salesforce_auth import get_salesforce_token
from server.talkdesk_explore import run_explore_report

# ── Constants ──────────────────────────────────────────────────────────────────
SF_INSTANCE_URL = os.getenv("SF_INSTANCE_URL", "")
DIST = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "dist"))
GOALS_FILE = os.path.join(os.path.dirname(__file__), "goals.json")
TTL_SF = 90.0   # seconds
TTL_TD = 300.0  # seconds
SFID_RE = re.compile(r"^[a-zA-Z0-9]{15,18}$")

DEFAULT_GOALS = {
    "closedDay": 15, "responseHrs": 4, "emailsDay": 20, "maxOnHold": 30,
    "maxOpen": 100, "transferRate": 10, "availPct": 55, "prodPct": 70,
    "contactsHr": 6, "slaBreach": 24, "instascore": 75, "fcrPct": 80,
    "totalPending": 500, "avgHoldSec": 120,
}

PRODUCTIVE_STATUSES = {
    "available", "on a call", "after call work", "chat",
    "transfer", "email queue", "outbound",
}

# ── Shared HTTP client (for SOQL queries in app.py) ────────────────────────────
_http = httpx.AsyncClient(timeout=60.0)

# ── Cache dicts ────────────────────────────────────────────────────────────────
def _new_cache():
    return {"data": None, "timestamp": None, "refresh_in_progress": False}

dashboard_cache  = _new_cache()
sla_cache        = _new_cache()
manager_cache    = _new_cache()
overview_cache   = _new_cache()
volume_cache     = _new_cache()
prod_cache       = _new_cache()
rep_perf_cache   = _new_cache()
resolution_cache = _new_cache()
td_metrics_cache = _new_cache()

# ── SF query helper ────────────────────────────────────────────────────────────
from urllib.parse import quote as _quote

async def sf_query(token: str, soql: str) -> dict:
    url = f"{SF_INSTANCE_URL}/services/data/v65.0/query?q={_quote(soql)}"
    resp = await _http.get(url, headers={"Authorization": f"Bearer {token}"})
    resp.raise_for_status()
    return resp.json()

# ── Owner filter helpers ───────────────────────────────────────────────────────
def build_owner_clause(owner_ids: list) -> str:
    safe = [i for i in (owner_ids or []) if SFID_RE.match(i)]
    if not safe:
        return ""
    ids_str = ",".join(f"'{i}'" for i in safe)
    return f" AND OwnerId IN ({ids_str})"


async def resolve_owner_ids(manager=None, owner_id=None, owner_ids_param=None) -> list:
    if owner_id and SFID_RE.match(owner_id):
        return [owner_id]
    if owner_ids_param:
        ids = [i for i in owner_ids_param.split(",") if SFID_RE.match(i)]
        if ids:
            return ids
    if manager:
        # Try manager cache first
        cached_users = (manager_cache.get("data") or {}).get("userInfo", {}).get("records", [])
        if cached_users:
            ids = [
                u["Id"] for u in cached_users
                if SFID_RE.match(u.get("Id", ""))
                and (
                    (u.get("Manager") or {}).get("Name", "") == manager
                    or (u.get("Manager") or {}).get("Name", "").startswith(manager + " ")
                )
            ]
            if ids:
                return ids
        # Fall back to SF query
        token = await get_salesforce_token()
        safe_manager = manager.replace("'", "\\'")
        q = (
            f"SELECT Id FROM User WHERE (Manager.Name = '{safe_manager}' OR Manager.Name LIKE '{safe_manager} %') "
            f"AND IsActive = true AND UserType = 'Standard' LIMIT 500"
        )
        data = await sf_query(token, q)
        return [u["Id"] for u in data.get("records", []) if SFID_RE.match(u.get("Id", ""))]
    return []

# ── Generic background refresh helper ─────────────────────────────────────────
async def _safe_refresh(refresh_fn, cache: dict, name: str):
    if cache["refresh_in_progress"]:
        print(f"⏭️  [{name}] Skipping refresh — already in progress")
        return
    cache["refresh_in_progress"] = True
    try:
        data = await refresh_fn()
        cache["data"] = data
        cache["timestamp"] = time.time()
        print(f"✅ [{name}] Cache updated at {datetime.now(timezone.utc).isoformat()}")
    except Exception as e:
        print(f"❌ [{name}] Refresh failed: {e}")
    finally:
        cache["refresh_in_progress"] = False


async def _bg_loop(refresh_fn, cache: dict, name: str, interval_sec: float):
    """Fire immediately then every interval_sec seconds."""
    await _safe_refresh(refresh_fn, cache, name)
    while True:
        await asyncio.sleep(interval_sec)
        await _safe_refresh(refresh_fn, cache, name)


# ── normalize name (for Talkdesk agent name matching) ─────────────────────────
def normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").lower().strip())

# ══════════════════════════════════════════════════════════════════════════════
# REFRESH FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

# ── Dashboard ─────────────────────────────────────────────────────────────────
async def refresh_dashboard():
    dashboard_id = os.environ["SALESFORCE_DASHBOARD_ID"]
    print(f"📊 [Salesforce] Starting dashboard refresh: {dashboard_id}")
    token = await get_salesforce_token()
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    try:
        print("🔄 [Salesforce] Triggering refresh...")
        refresh_resp = await _http.put(
            f"{SF_INSTANCE_URL}/services/data/v65.0/analytics/dashboards/{dashboard_id}",
            json={},
            headers=h,
        )
        refresh_resp.raise_for_status()
        print("✅ [Salesforce] Refresh initiated")

        status_url = refresh_resp.json().get("statusUrl")
        if not status_url:
            print("⚠️  [Salesforce] No statusUrl in PUT response, waiting 20s...")
            await asyncio.sleep(20)
        else:
            print(f"📊 [Salesforce] Status URL: {status_url}")
            max_attempts = 30
            for attempt in range(1, max_attempts + 1):
                await asyncio.sleep(2)
                try:
                    status_resp = await _http.get(
                        f"{SF_INSTANCE_URL}{status_url}", headers=h
                    )
                    status_resp.raise_for_status()
                    component_status = status_resp.json().get("componentStatus", [])
                    running = [c for c in component_status if c.get("refreshStatus") == "RUNNING"]
                    print(f"🔍 [Salesforce] Status {attempt}/{max_attempts}: {len(running)} running")
                    if not running:
                        print(f"✅ [Salesforce] All {len(component_status)} components ready")
                        break
                except Exception as e:
                    print(f"⚠️  [Salesforce] Status check error (attempt {attempt}): {e}")
            else:
                print(f"⚠️  [Salesforce] Refresh timeout after {max_attempts} attempts, continuing anyway")

    except httpx.HTTPStatusError as e:
        data = e.response.json() if e.response.content else []
        msg = (data[0].get("message") if isinstance(data, list) and data else "") or ""
        if e.response.status_code == 403 and "more than once in a minute" in msg:
            print("⚠️  [Salesforce] Rate limited — fetching current data without refresh")
        else:
            raise

    print("📥 [Salesforce] Fetching fresh dashboard data...")
    data_resp = await _http.get(
        f"{SF_INSTANCE_URL}/services/data/v65.0/analytics/dashboards/{dashboard_id}",
        headers=h,
    )
    data_resp.raise_for_status()
    result = data_resp.json()
    print(f"✅ [Salesforce] Fresh data retrieved (refreshDate: {result.get('refreshDate')})")
    return result


# ── SLA ───────────────────────────────────────────────────────────────────────
SLA_SOQL = (
    "SELECT Id, CaseNumber, Subject, Status, OwnerId, Owner.Name, "
    "CreatedDate, SlaStartDate, Case_Response_Time_Hours__c "
    "FROM Case "
    "WHERE Owner.Type = 'User' "
    "AND CreatedDate >= LAST_N_DAYS:90 "
    "AND Case_Response_Time_Hours__c != null "
    "ORDER BY CreatedDate DESC "
    "LIMIT 2000"
)

async def refresh_sla():
    token = await get_salesforce_token()
    print("📋 [SLA] Fetching SOQL case data...")
    data = await sf_query(token, SLA_SOQL)
    print(f"✅ [SLA] {data.get('totalSize', 0)} cases fetched")
    return data


# ── Manager Scorecard ─────────────────────────────────────────────────────────
async def refresh_manager():
    token = await get_salesforce_token()
    print("👔 [Manager] Fetching manager scorecard data (5 parallel queries)...")

    (open_by_status, closed_week, avg_response, csat_data, user_info) = await asyncio.gather(
        sf_query(token, "SELECT OwnerId, Owner.Name, Status, COUNT(Id) cnt FROM Case WHERE IsClosed = false AND Owner.Type = 'User' GROUP BY OwnerId, Owner.Name, Status"),
        sf_query(token, "SELECT OwnerId, COUNT(Id) cnt FROM Case WHERE IsClosed = true AND Owner.Type = 'User' AND ClosedDate >= LAST_N_DAYS:7 GROUP BY OwnerId"),
        sf_query(token, "SELECT OwnerId, AVG(Case_Response_Time_Hours__c) avgRespHrs FROM Case WHERE IsClosed = true AND Owner.Type = 'User' AND ClosedDate >= LAST_N_DAYS:30 AND Case_Response_Time_Hours__c != null GROUP BY OwnerId"),
        sf_query(token, "SELECT OwnerId, Satisfaction_Score__c FROM Case WHERE Satisfaction_Score__c != null AND Owner.Type = 'User' AND CreatedDate >= LAST_N_DAYS:30 LIMIT 2000"),
        sf_query(token, "SELECT Id, Name, Manager.Name, UserRole.Name, Department FROM User WHERE IsActive = true AND UserType = 'Standard' LIMIT 500"),
    )

    print(f"✅ [Manager] openByStatus={open_by_status.get('totalSize')} closedWeek={closed_week.get('totalSize')} users={user_info.get('totalSize')}")
    return {
        "openByStatus": open_by_status,
        "closedWeek":   closed_week,
        "avgResponse":  avg_response,
        "csatData":     csat_data,
        "userInfo":     user_info,
    }


# ── Overview ──────────────────────────────────────────────────────────────────
async def refresh_overview(owner_ids=None, period="week"):
    if owner_ids is None:
        owner_ids = []
    owner_clause = build_owner_clause(owner_ids)

    token = await get_salesforce_token()

    if period == "today":
        closed_date_filter  = "ClosedDate = TODAY"
        created_date_filter = "CreatedDate = TODAY"
    elif period == "month":
        closed_date_filter  = "ClosedDate = THIS_MONTH"
        created_date_filter = "CreatedDate = THIS_MONTH"
    else:
        closed_date_filter  = "ClosedDate = THIS_WEEK"
        created_date_filter = "CreatedDate = THIS_WEEK"

    avg_resp_lookback = "LAST_N_DAYS:30" if period == "month" else "LAST_N_DAYS:7"
    print(f"🏠 [Overview] Fetching data period={period} owners={len(owner_ids) or 'all'}...")

    (status_totals, closed_today, avg_response, daily_closed_14d, hourly_new, emails_today) = await asyncio.gather(
        sf_query(token, f"SELECT Status, COUNT(Id) cnt FROM Case WHERE IsClosed = false AND Owner.Type = 'User'{owner_clause} GROUP BY Status ORDER BY COUNT(Id) DESC"),
        sf_query(token, f"SELECT COUNT() FROM Case WHERE IsClosed = true AND {closed_date_filter} AND Owner.Type = 'User'{owner_clause}"),
        sf_query(token, f"SELECT AVG(Case_Response_Time_Hours__c) avgResp FROM Case WHERE IsClosed = true AND ClosedDate >= {avg_resp_lookback} AND Owner.Type = 'User'{owner_clause} AND Case_Response_Time_Hours__c != null"),
        sf_query(token, f"SELECT DAY_ONLY(ClosedDate) day, COUNT(Id) cnt FROM Case WHERE IsClosed = true AND ClosedDate >= LAST_N_DAYS:14 AND Owner.Type = 'User'{owner_clause} GROUP BY DAY_ONLY(ClosedDate) ORDER BY DAY_ONLY(ClosedDate) ASC"),
        sf_query(token, f"SELECT HOUR_IN_DAY(CreatedDate) hr, COUNT(Id) cnt FROM Case WHERE CreatedDate = TODAY{owner_clause} GROUP BY HOUR_IN_DAY(CreatedDate) ORDER BY HOUR_IN_DAY(CreatedDate) ASC"),
        sf_query(token, f"SELECT COUNT() FROM Case WHERE Origin = 'Email' AND {created_date_filter}{owner_clause}"),
    )

    print(f"✅ [Overview] status={status_totals.get('totalSize')} dailyClosed={daily_closed_14d.get('totalSize')} hourly={hourly_new.get('totalSize')}")
    return {
        "statusTotals":   status_totals,
        "closedToday":    closed_today.get("totalSize", 0),
        "avgResponseHrs": (avg_response.get("records") or [{}])[0].get("avgResp") or 0,
        "dailyClosed14d": daily_closed_14d,
        "hourlyNew":      hourly_new,
        "emailsToday":    emails_today.get("totalSize", 0),
        "period":         period,
    }


# ── Volume ────────────────────────────────────────────────────────────────────
async def refresh_volume():
    token = await get_salesforce_token()
    print("📈 [Volume] Fetching volume/inflow data (6 parallel queries)...")

    (origin_today, hourly_today, daily_14d, type_breakdown, email_daily_14d, open_count) = await asyncio.gather(
        sf_query(token, "SELECT Origin, COUNT(Id) cnt FROM Case WHERE CreatedDate = TODAY GROUP BY Origin ORDER BY COUNT(Id) DESC"),
        sf_query(token, "SELECT HOUR_IN_DAY(CreatedDate) hr, COUNT(Id) cnt FROM Case WHERE CreatedDate = TODAY GROUP BY HOUR_IN_DAY(CreatedDate) ORDER BY HOUR_IN_DAY(CreatedDate) ASC"),
        sf_query(token, "SELECT DAY_ONLY(CreatedDate) day, COUNT(Id) cnt FROM Case WHERE CreatedDate >= LAST_N_DAYS:14 GROUP BY DAY_ONLY(CreatedDate) ORDER BY DAY_ONLY(CreatedDate) ASC"),
        sf_query(token, "SELECT Type, COUNT(Id) cnt FROM Case WHERE CreatedDate >= LAST_N_DAYS:7 AND Type != null GROUP BY Type ORDER BY COUNT(Id) DESC LIMIT 12"),
        sf_query(token, "SELECT DAY_ONLY(CreatedDate) day, COUNT(Id) cnt FROM Case WHERE Origin = 'Email' AND CreatedDate >= LAST_N_DAYS:14 GROUP BY DAY_ONLY(CreatedDate) ORDER BY DAY_ONLY(CreatedDate) ASC"),
        sf_query(token, "SELECT COUNT() FROM Case WHERE IsClosed = false AND Owner.Type = 'User'"),
    )

    print(f"✅ [Volume] originToday={origin_today.get('totalSize')} hourly={hourly_today.get('totalSize')} daily14d={daily_14d.get('totalSize')} types={type_breakdown.get('totalSize')} emailDays={email_daily_14d.get('totalSize')} open={open_count.get('totalSize')}")
    return {
        "originToday":   origin_today,
        "hourlyToday":   hourly_today,
        "daily14d":      daily_14d,
        "typeBreakdown": type_breakdown,
        "emailDaily14d": email_daily_14d,
        "totalOpen":     open_count.get("totalSize", 0),
    }


# ── Productivity ──────────────────────────────────────────────────────────────
async def refresh_prod():
    token = await get_salesforce_token()
    print("⚡ [Prod] Fetching productivity data (4 parallel queries)...")

    (aht_res, csat_res, closed_week_res, user_res) = await asyncio.gather(
        sf_query(token, "SELECT OwnerId, Owner.Name, COUNT(Id) cnt, AVG(Case_Response_Time_Hours__c) avgRespHrs FROM Case WHERE IsClosed = true AND Owner.Type = 'User' AND ClosedDate >= LAST_N_DAYS:30 GROUP BY OwnerId, Owner.Name"),
        sf_query(token, "SELECT OwnerId, Satisfaction_Score__c FROM Case WHERE Satisfaction_Score__c != null AND Owner.Type = 'User' AND CreatedDate >= LAST_N_DAYS:30 LIMIT 2000"),
        sf_query(token, "SELECT OwnerId, COUNT(Id) cnt FROM Case WHERE IsClosed = true AND Owner.Type = 'User' AND ClosedDate >= LAST_N_DAYS:7 GROUP BY OwnerId"),
        sf_query(token, "SELECT Id, Name, Manager.Name, UserRole.Name, Department FROM User WHERE IsActive = true AND UserType = 'Standard' LIMIT 500"),
    )

    print(f"✅ [Prod] aht={aht_res.get('totalSize')} csat={csat_res.get('totalSize')} closedWeek={closed_week_res.get('totalSize')} users={user_res.get('totalSize')}")
    return {
        "ahtData":    aht_res,
        "csatData":   csat_res,
        "closedWeek": closed_week_res,
        "userInfo":   user_res,
    }


# ── Rep Performance ───────────────────────────────────────────────────────────
async def refresh_rep_perf():
    token = await get_salesforce_token()
    print("👥 [RepPerf] Fetching rep performance data (6 parallel queries)...")

    (open_by_status, closed_today, closed_week, oldest_open, user_info, daily_trend) = await asyncio.gather(
        sf_query(token, "SELECT OwnerId, Owner.Name, Status, COUNT(Id) cnt FROM Case WHERE IsClosed = false AND Owner.Type = 'User' GROUP BY OwnerId, Owner.Name, Status"),
        sf_query(token, "SELECT OwnerId, COUNT(Id) cnt FROM Case WHERE IsClosed = true AND ClosedDate = TODAY AND Owner.Type = 'User' GROUP BY OwnerId"),
        sf_query(token, "SELECT OwnerId, COUNT(Id) cnt FROM Case WHERE IsClosed = true AND ClosedDate >= LAST_N_DAYS:7 AND Owner.Type = 'User' GROUP BY OwnerId"),
        sf_query(token, "SELECT OwnerId, MIN(CreatedDate) minDate FROM Case WHERE IsClosed = false AND Owner.Type = 'User' GROUP BY OwnerId"),
        sf_query(token, "SELECT Id, Name, Manager.Name, Department, UserRole.Name FROM User WHERE IsActive = true AND UserType = 'Standard' LIMIT 500"),
        sf_query(token, "SELECT DAY_ONLY(ClosedDate) day, COUNT(Id) cnt FROM Case WHERE IsClosed = true AND ClosedDate >= LAST_N_DAYS:14 GROUP BY DAY_ONLY(ClosedDate) ORDER BY DAY_ONLY(ClosedDate) ASC"),
    )

    print(f"✅ [RepPerf] openByStatus={open_by_status.get('totalSize')} closedToday={closed_today.get('totalSize')} closedWeek={closed_week.get('totalSize')} users={user_info.get('totalSize')}")
    return {
        "openByStatus": open_by_status,
        "closedToday":  closed_today,
        "closedWeek":   closed_week,
        "oldestOpen":   oldest_open,
        "userInfo":     user_info,
        "dailyTrend":   daily_trend,
    }


# ── Resolution ────────────────────────────────────────────────────────────────
async def refresh_resolution():
    token = await get_salesforce_token()
    print("📋 [Resolution] Fetching resolution data (4 parallel queries)...")

    (closed_res, created_res, daily_created_res, daily_closed_res) = await asyncio.gather(
        sf_query(token, "SELECT Id, OwnerId, Owner.Name, CreatedDate, ClosedDate, IsEscalated, Reopens__c FROM Case WHERE IsClosed = true AND Owner.Type = 'User' AND ClosedDate >= LAST_N_DAYS:30 ORDER BY ClosedDate DESC LIMIT 2000"),
        sf_query(token, "SELECT OwnerId, Owner.Name, COUNT(Id) cnt FROM Case WHERE CreatedDate >= LAST_N_DAYS:7 AND Owner.Type = 'User' GROUP BY OwnerId, Owner.Name"),
        sf_query(token, "SELECT DAY_ONLY(CreatedDate) day, COUNT(Id) cnt FROM Case WHERE CreatedDate >= LAST_N_DAYS:14 GROUP BY DAY_ONLY(CreatedDate) ORDER BY DAY_ONLY(CreatedDate) ASC"),
        sf_query(token, "SELECT DAY_ONLY(ClosedDate) day, COUNT(Id) cnt FROM Case WHERE IsClosed = true AND ClosedDate >= LAST_N_DAYS:14 GROUP BY DAY_ONLY(ClosedDate) ORDER BY DAY_ONLY(ClosedDate) ASC"),
    )

    print(f"✅ [Resolution] closed={closed_res.get('totalSize')} createdByRep={created_res.get('totalSize')} dailyCreated={daily_created_res.get('totalSize')} dailyClosed={daily_closed_res.get('totalSize')}")
    return {
        "closedCases":  closed_res,
        "createdByRep": created_res,
        "dailyCreated": daily_created_res,
        "dailyClosed":  daily_closed_res,
    }


# ── Talkdesk Metrics ──────────────────────────────────────────────────────────
async def refresh_td_metrics():
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    from_iso  = today_start.isoformat().replace("+00:00", "Z")
    to_iso    = now.isoformat().replace("+00:00", "Z")
    tz        = os.getenv("TD_TIMEZONE", "America/Chicago")

    print(f"📞 [TD Metrics] Running Explore jobs (contacts + adherence) for {from_iso} → {to_iso}")

    results = await asyncio.gather(
        run_explore_report("contacts",  {"timespan": {"from": from_iso, "to": to_iso}, "timezone": tz, "format": "json"}),
        run_explore_report("adherence", {"timespan": {"from": from_iso, "to": to_iso}, "timezone": tz, "format": "json"}),
        return_exceptions=True,
    )
    contacts_result, adherence_result = results

    # ── Avg hold time ──────────────────────────────────────────────────────────
    avg_hold_sec = None
    hold_by_agent = {}
    if isinstance(contacts_result, Exception):
        print(f"⚠️  [TD Metrics] contacts failed: {contacts_result}")
    else:
        rows = contacts_result
        if rows:
            print(f"[TD Debug] contacts row keys: {list(rows[0].keys())}")
        with_hold = [r for r in rows if r.get("hold_time") is not None and r.get("hold_time", 0) > 0]
        if with_hold:
            avg_hold_sec = round(sum(r["hold_time"] for r in with_hold) / len(with_hold))
        for row in rows:
            key = normalize_name(row.get("agent_name", ""))
            if not key:
                continue
            if key not in hold_by_agent:
                hold_by_agent[key] = {"sum": 0, "count": 0}
            if row.get("hold_time") is not None and row.get("hold_time", 0) > 0:
                hold_by_agent[key]["sum"]   += row["hold_time"]
                hold_by_agent[key]["count"] += 1
        print(f"✅ [TD Metrics] contacts rows={len(rows)}, withHold={len(with_hold)}, avgHoldSec={avg_hold_sec}")

    # ── Avg availability % ─────────────────────────────────────────────────────
    avg_avail_pct = None
    avail_by_agent = {}
    if isinstance(adherence_result, Exception):
        print(f"⚠️  [TD Metrics] adherence failed: {adherence_result}")
    else:
        rows = adherence_result
        if rows:
            print(f"[TD Debug] adherence row keys: {list(rows[0].keys())}")
        on_shift = [r for r in rows if r.get("shift_status") == "On Shift"]
        total_time = sum(r.get("adherence_event_duration", 0) for r in on_shift)
        avail_time = sum(
            r.get("adherence_event_duration", 0) for r in on_shift
            if (r.get("actual_status") or "").lower() in PRODUCTIVE_STATUSES
        )
        if total_time > 0:
            avg_avail_pct = round((avail_time / total_time) * 100, 1)
        for row in on_shift:
            key = normalize_name(row.get("agent_name", ""))
            if not key:
                continue
            if key not in avail_by_agent:
                avail_by_agent[key] = {"total_time": 0, "avail_time": 0}
            avail_by_agent[key]["total_time"] += row.get("adherence_event_duration", 0)
            if (row.get("actual_status") or "").lower() in PRODUCTIVE_STATUSES:
                avail_by_agent[key]["avail_time"] += row.get("adherence_event_duration", 0)
        print(f"✅ [TD Metrics] adherence rows={len(rows)} (onShift={len(on_shift)}), totalTime={total_time}s, availTime={avail_time}s, avgAvailPct={avg_avail_pct}")

    # ── Per-agent map ──────────────────────────────────────────────────────────
    by_agent = {}
    for name in set(list(hold_by_agent) + list(avail_by_agent)):
        h = hold_by_agent.get(name)
        a = avail_by_agent.get(name)
        by_agent[name] = {
            "avgHoldSec": round(h["sum"] / h["count"]) if h and h["count"] > 0 else None,
            "availPct":   round((a["avail_time"] / a["total_time"]) * 100, 1) if a and a["total_time"] > 0 else None,
        }

    return {
        "org":     {"avgHoldSec": avg_hold_sec, "avgAvailPct": avg_avail_pct},
        "byAgent": by_agent,
    }


# ══════════════════════════════════════════════════════════════════════════════
# FASTAPI APP
# ══════════════════════════════════════════════════════════════════════════════
app = FastAPI()

# ── Static files (React build) ─────────────────────────────────────────────────
_assets_dir = os.path.join(DIST, "assets")
if os.path.isdir(_assets_dir):
    app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

# ── Startup ────────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    # SF data — fire immediately, then every 90s
    sf_tasks = [
        (refresh_dashboard,  dashboard_cache,  "Salesforce"),
        (refresh_sla,        sla_cache,        "SLA"),
        (refresh_resolution, resolution_cache, "Resolution"),
        (refresh_prod,       prod_cache,       "Prod"),
        (refresh_rep_perf,   rep_perf_cache,   "RepPerf"),
        (refresh_volume,     volume_cache,     "Volume"),
        (refresh_overview,   overview_cache,   "Overview"),
        (refresh_manager,    manager_cache,    "Manager"),
    ]
    for fn, cache, name in sf_tasks:
        asyncio.create_task(_bg_loop(fn, cache, name, TTL_SF))

    # Talkdesk — start after 90s delay to avoid hammering Explore rate limit
    if all(os.getenv(k) for k in ["TD_ACCOUNT_ID", "TD_CLIENT_ID", "TD_PRIVATE_KEY"]):
        asyncio.create_task(_td_delayed_start())
    else:
        print("⚠️  [TD Metrics] Skipping — TD_ACCOUNT_ID / TD_CLIENT_ID / TD_PRIVATE_KEY not set")


async def _td_delayed_start():
    print("📞 [TD Metrics] Will start in 90s...")
    await asyncio.sleep(90)
    await _bg_loop(refresh_td_metrics, td_metrics_cache, "TD Metrics", TTL_TD)


# ── Endpoint helpers ───────────────────────────────────────────────────────────
def _cached_or_refresh_in_progress(cache: dict, name: str):
    """Return cached JSON if fresh, else None."""
    if cache["data"] and cache["timestamp"]:
        age_s = time.time() - cache["timestamp"]
        if age_s < TTL_SF:
            print(f"📦 [{name}] Returning cached data (age: {age_s:.0f}s)")
            return cache["data"]
    return None


# ══════════════════════════════════════════════════════════════════════════════
# API ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

# ── GET /api/dashboard-data ────────────────────────────────────────────────────
@app.get("/api/dashboard-data")
async def get_dashboard_data():
    try:
        if dashboard_cache["data"] and dashboard_cache["timestamp"] and \
                (time.time() - dashboard_cache["timestamp"]) < TTL_SF:
            age_s = time.time() - dashboard_cache["timestamp"]
            print(f"📦 [Salesforce] Returning cached data (age: {age_s:.0f}s)")
            return dashboard_cache["data"]
        if dashboard_cache["refresh_in_progress"]:
            if dashboard_cache["data"]:
                return dashboard_cache["data"]
            return {"componentData": [], "refreshing": True, "message": "Dashboard refresh in progress"}
        print("🔄 [Salesforce] Cache miss, fetching directly...")
        token = await get_salesforce_token()
        dashboard_id = os.environ["SALESFORCE_DASHBOARD_ID"]
        resp = await _http.get(
            f"{SF_INSTANCE_URL}/services/data/v65.0/analytics/dashboards/{dashboard_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        dashboard_cache["data"] = resp.json()
        dashboard_cache["timestamp"] = time.time()
        return dashboard_cache["data"]
    except Exception as e:
        print(f"❌ [Salesforce] Error: {e}")
        if dashboard_cache["data"]:
            return dashboard_cache["data"]
        return {"componentData": [], "error": True, "message": str(e)}


# ── GET /api/sla-data ──────────────────────────────────────────────────────────
@app.get("/api/sla-data")
async def get_sla_data():
    try:
        if sla_cache["data"] and sla_cache["timestamp"] and \
                (time.time() - sla_cache["timestamp"]) < TTL_SF:
            age_s = time.time() - sla_cache["timestamp"]
            print(f"📦 [SLA] Returning cached data (age: {age_s:.0f}s)")
            return sla_cache["data"]
        if sla_cache["refresh_in_progress"]:
            if sla_cache["data"]:
                return sla_cache["data"]
            return {"records": [], "totalSize": 0, "refreshing": True}
        print("🔄 [SLA] Cache miss, fetching directly...")
        sla_cache["data"] = await refresh_sla()
        sla_cache["timestamp"] = time.time()
        return sla_cache["data"]
    except Exception as e:
        print(f"❌ [SLA] Error: {e}")
        if sla_cache["data"]:
            return sla_cache["data"]
        return {"records": [], "totalSize": 0, "error": True, "message": str(e)}


# ── GET /api/manager-data ──────────────────────────────────────────────────────
@app.get("/api/manager-data")
async def get_manager_data():
    empty = {"openByStatus": {"records": []}, "closedWeek": {"records": []}, "avgResponse": {"records": []}, "csatData": {"records": []}, "userInfo": {"records": []}}
    try:
        if manager_cache["data"] and manager_cache["timestamp"] and \
                (time.time() - manager_cache["timestamp"]) < TTL_SF:
            age_s = time.time() - manager_cache["timestamp"]
            print(f"📦 [Manager] Returning cached data (age: {age_s:.0f}s)")
            return manager_cache["data"]
        if manager_cache["refresh_in_progress"]:
            if manager_cache["data"]:
                return manager_cache["data"]
            return {**empty, "refreshing": True}
        print("🔄 [Manager] Cache miss, fetching directly...")
        manager_cache["data"] = await refresh_manager()
        manager_cache["timestamp"] = time.time()
        return manager_cache["data"]
    except Exception as e:
        print(f"❌ [Manager] Error: {e}")
        if manager_cache["data"]:
            return manager_cache["data"]
        return {**empty, "error": True}


# ── GET /api/overview-data ─────────────────────────────────────────────────────
@app.get("/api/overview-data")
async def get_overview_data(
    manager: str = None,
    ownerId: str = None,
    ownerIds: str = None,
    period: str = "week",
):
    empty = {"statusTotals": {"records": []}, "closedToday": 0, "avgResponseHrs": 0, "dailyClosed14d": {"records": []}, "hourlyNew": {"records": []}, "emailsToday": 0}
    is_filtered = bool(manager or ownerId or ownerIds) or period != "week"

    try:
        if not is_filtered:
            if overview_cache["data"] and overview_cache["timestamp"] and \
                    (time.time() - overview_cache["timestamp"]) < TTL_SF:
                age_s = time.time() - overview_cache["timestamp"]
                print(f"📦 [Overview] Returning cached data (age: {age_s:.0f}s)")
                return overview_cache["data"]
            if overview_cache["refresh_in_progress"]:
                if overview_cache["data"]:
                    return overview_cache["data"]
                return {**empty, "refreshing": True}
            print("🔄 [Overview] Cache miss, fetching directly...")
            overview_cache["data"] = await refresh_overview()
            overview_cache["timestamp"] = time.time()
            return overview_cache["data"]

        # Filtered request: bypass cache
        owner_ids = await resolve_owner_ids(manager, ownerId, ownerIds)
        return await refresh_overview(owner_ids=owner_ids, period=period)
    except Exception as e:
        print(f"❌ [Overview] Error: {e}")
        if overview_cache["data"]:
            return overview_cache["data"]
        return {**empty, "error": True}


# ── GET /api/volume-data ───────────────────────────────────────────────────────
@app.get("/api/volume-data")
async def get_volume_data():
    empty = {"originToday": {"records": []}, "hourlyToday": {"records": []}, "daily14d": {"records": []}, "typeBreakdown": {"records": []}, "emailDaily14d": {"records": []}, "totalOpen": 0}
    try:
        if volume_cache["data"] and volume_cache["timestamp"] and \
                (time.time() - volume_cache["timestamp"]) < TTL_SF:
            age_s = time.time() - volume_cache["timestamp"]
            print(f"📦 [Volume] Returning cached data (age: {age_s:.0f}s)")
            return volume_cache["data"]
        if volume_cache["refresh_in_progress"]:
            if volume_cache["data"]:
                return volume_cache["data"]
            return {**empty, "refreshing": True}
        print("🔄 [Volume] Cache miss, fetching directly...")
        volume_cache["data"] = await refresh_volume()
        volume_cache["timestamp"] = time.time()
        return volume_cache["data"]
    except Exception as e:
        print(f"❌ [Volume] Error: {e}")
        if volume_cache["data"]:
            return volume_cache["data"]
        return {**empty, "error": True}


# ── GET /api/productivity-data ─────────────────────────────────────────────────
@app.get("/api/productivity-data")
async def get_productivity_data():
    empty = {"ahtData": {"records": []}, "csatData": {"records": []}, "closedWeek": {"records": []}, "userInfo": {"records": []}}
    try:
        if prod_cache["data"] and prod_cache["timestamp"] and \
                (time.time() - prod_cache["timestamp"]) < TTL_SF:
            age_s = time.time() - prod_cache["timestamp"]
            print(f"📦 [Prod] Returning cached data (age: {age_s:.0f}s)")
            return prod_cache["data"]
        if prod_cache["refresh_in_progress"]:
            if prod_cache["data"]:
                return prod_cache["data"]
            return {**empty, "refreshing": True}
        print("🔄 [Prod] Cache miss, fetching directly...")
        prod_cache["data"] = await refresh_prod()
        prod_cache["timestamp"] = time.time()
        return prod_cache["data"]
    except Exception as e:
        print(f"❌ [Prod] Error: {e}")
        if prod_cache["data"]:
            return prod_cache["data"]
        return {**empty, "error": True}


# ── GET /api/rep-performance-data ──────────────────────────────────────────────
@app.get("/api/rep-performance-data")
async def get_rep_performance_data():
    empty = {"openByStatus": {"records": []}, "closedToday": {"records": []}, "closedWeek": {"records": []}, "oldestOpen": {"records": []}, "userInfo": {"records": []}, "dailyTrend": {"records": []}}
    try:
        if rep_perf_cache["data"] and rep_perf_cache["timestamp"] and \
                (time.time() - rep_perf_cache["timestamp"]) < TTL_SF:
            age_s = time.time() - rep_perf_cache["timestamp"]
            print(f"📦 [RepPerf] Returning cached data (age: {age_s:.0f}s)")
            return rep_perf_cache["data"]
        if rep_perf_cache["refresh_in_progress"]:
            if rep_perf_cache["data"]:
                return rep_perf_cache["data"]
            return {**empty, "refreshing": True}
        print("🔄 [RepPerf] Cache miss, fetching directly...")
        rep_perf_cache["data"] = await refresh_rep_perf()
        rep_perf_cache["timestamp"] = time.time()
        return rep_perf_cache["data"]
    except Exception as e:
        print(f"❌ [RepPerf] Error: {e}")
        if rep_perf_cache["data"]:
            return rep_perf_cache["data"]
        return {**empty, "error": True}


# ── GET /api/resolution-data ───────────────────────────────────────────────────
@app.get("/api/resolution-data")
async def get_resolution_data():
    empty = {"closedCases": {"records": []}, "createdByRep": {"records": []}, "dailyCreated": {"records": []}, "dailyClosed": {"records": []}}
    try:
        if resolution_cache["data"] and resolution_cache["timestamp"] and \
                (time.time() - resolution_cache["timestamp"]) < TTL_SF:
            age_s = time.time() - resolution_cache["timestamp"]
            print(f"📦 [Resolution] Returning cached data (age: {age_s:.0f}s)")
            return resolution_cache["data"]
        if resolution_cache["refresh_in_progress"]:
            if resolution_cache["data"]:
                return resolution_cache["data"]
            return {**empty, "refreshing": True}
        print("🔄 [Resolution] Cache miss, fetching directly...")
        resolution_cache["data"] = await refresh_resolution()
        resolution_cache["timestamp"] = time.time()
        return resolution_cache["data"]
    except Exception as e:
        print(f"❌ [Resolution] Error: {e}")
        if resolution_cache["data"]:
            return resolution_cache["data"]
        return {**empty, "error": True}


# ── GET /api/talkdesk-metrics ──────────────────────────────────────────────────
@app.get("/api/talkdesk-metrics")
async def get_talkdesk_metrics():
    empty = {"org": {"avgHoldSec": None, "avgAvailPct": None}, "byAgent": {}}
    try:
        if td_metrics_cache["data"] and td_metrics_cache["timestamp"] and \
                (time.time() - td_metrics_cache["timestamp"]) < TTL_TD:
            age_s = time.time() - td_metrics_cache["timestamp"]
            print(f"📦 [TD Metrics] Returning cached data (age: {age_s:.0f}s)")
            return td_metrics_cache["data"]
        if td_metrics_cache["refresh_in_progress"]:
            if td_metrics_cache["data"]:
                return td_metrics_cache["data"]
            return {**empty, "refreshing": True}
        print("🔄 [TD Metrics] Cache miss, fetching directly...")
        td_metrics_cache["data"] = await refresh_td_metrics()
        td_metrics_cache["timestamp"] = time.time()
        return td_metrics_cache["data"]
    except Exception as e:
        print(f"❌ [TD Metrics] Error: {e}")
        if td_metrics_cache["data"]:
            return td_metrics_cache["data"]
        return {**empty, "error": True}


# ── GET /api/rep-list ──────────────────────────────────────────────────────────
@app.get("/api/rep-list")
async def get_rep_list():
    records = (manager_cache.get("data") or {}).get("userInfo", {}).get("records", [])
    return {"records": records}


# ── GET /api/rep-detail ────────────────────────────────────────────────────────
@app.get("/api/rep-detail")
async def get_rep_detail(ownerId: str = None):
    if not ownerId or not SFID_RE.match(ownerId):
        return JSONResponse(status_code=400, content={"error": "Invalid or missing ownerId"})
    safe = ownerId.strip()
    try:
        token = await get_salesforce_token()
        print(f"🔍 [RepDetail] Fetching detail for {safe}...")

        (cases, closed_today, closed_week, closed_last_week, avg_resp, csat_recs) = await asyncio.gather(
            sf_query(token, f"SELECT Id, CaseNumber, Subject, Status, CreatedDate, LastModifiedDate, Case_Response_Time_Hours__c FROM Case WHERE IsClosed = false AND OwnerId = '{safe}' ORDER BY CreatedDate ASC LIMIT 500"),
            sf_query(token, f"SELECT COUNT() FROM Case WHERE IsClosed = true AND OwnerId = '{safe}' AND ClosedDate = TODAY"),
            sf_query(token, f"SELECT COUNT() FROM Case WHERE IsClosed = true AND OwnerId = '{safe}' AND ClosedDate = THIS_WEEK"),
            sf_query(token, f"SELECT COUNT() FROM Case WHERE IsClosed = true AND OwnerId = '{safe}' AND ClosedDate = LAST_WEEK"),
            sf_query(token, f"SELECT AVG(Case_Response_Time_Hours__c) avgResp FROM Case WHERE IsClosed = true AND OwnerId = '{safe}' AND ClosedDate >= LAST_N_DAYS:30 AND Case_Response_Time_Hours__c != null"),
            sf_query(token, f"SELECT Satisfaction_Score__c FROM Case WHERE OwnerId = '{safe}' AND Satisfaction_Score__c != null AND CreatedDate >= LAST_N_DAYS:30 LIMIT 200"),
        )

        print(f"✅ [RepDetail] cases={cases.get('totalSize')} closedWk={closed_week.get('totalSize')}")
        return {
            "cases":          cases,
            "closedToday":    closed_today.get("totalSize", 0),
            "closedWeek":     closed_week.get("totalSize", 0),
            "closedLastWeek": closed_last_week.get("totalSize", 0),
            "avgResponseHrs": (avg_resp.get("records") or [{}])[0].get("avgResp") or 0,
            "csatData":       csat_recs,
        }
    except Exception as e:
        print(f"❌ [RepDetail] Error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


# ── Goals persistence ──────────────────────────────────────────────────────────
@app.get("/api/goals")
async def get_goals():
    try:
        if os.path.exists(GOALS_FILE):
            with open(GOALS_FILE) as f:
                return json.load(f)
        return DEFAULT_GOALS
    except Exception as e:
        print(f"❌ [Goals] Read error: {e}")
        return DEFAULT_GOALS


async def _save_goals(request: Request):
    try:
        body = await request.json()
        with open(GOALS_FILE, "w") as f:
            json.dump(body, f, indent=2)
        print("✅ [Goals] Saved goals")
        return {"ok": True}
    except Exception as e:
        print(f"❌ [Goals] Write error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

app.add_api_route("/api/goals", _save_goals, methods=["POST", "PUT"])


# ── Health check ───────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    cache_age = None
    if dashboard_cache["timestamp"]:
        cache_age = f"{int(time.time() - dashboard_cache['timestamp'])}s"
    return {
        "status": "ok",
        "cacheAge": cache_age or "no cache",
        "refreshInProgress": dashboard_cache["refresh_in_progress"],
    }


# ── SPA fallback (must be LAST — catches all unmatched GET routes) ──────────────
@app.get("/")
async def root():
    return FileResponse(os.path.join(DIST, "index.html"))


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    return FileResponse(os.path.join(DIST, "index.html"))
