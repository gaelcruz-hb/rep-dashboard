"""
talkdesk_auth.py
Talkdesk OAuth2 ES256 JWT Bearer auth — port of talkdeskAuth.js

Required env vars:
  TD_ACCOUNT_ID  — Talkdesk account subdomain, e.g. "homebase"
  TD_CLIENT_ID   — OAuth2 client_id (iss/sub in JWT)
  TD_KEY_ID      — Key ID included as `kid` in the JWT header
  TD_PRIVATE_KEY — EC private key PEM (raw content with \\n escapes, or file path)

Token is cached for 55 minutes (tokens expire at 60m).
"""

import os
import time
import uuid
import asyncio
import jwt  # PyJWT
import httpx

_cached_token: str | None = None
_token_expires_at: float = 0.0
_inflight: asyncio.Task | None = None
_http_client = httpx.AsyncClient()


def _load_private_key() -> str:
    raw = os.environ.get("TD_PRIVATE_KEY", "")
    if not raw:
        raise ValueError("TD_PRIVATE_KEY env var is not set")
    if raw.startswith("-----BEGIN"):
        return raw.replace("\\n", "\n")
    with open(raw) as f:
        return f.read()


def _generate_jwt() -> str:
    td_client_id  = os.environ["TD_CLIENT_ID"]
    td_key_id     = os.environ["TD_KEY_ID"]
    td_account_id = os.environ["TD_ACCOUNT_ID"]
    private_key   = _load_private_key()

    now = int(time.time())
    payload = {
        "iss": td_client_id,
        "sub": td_client_id,
        "aud": f"https://{td_account_id}.talkdeskid.com/oauth/token",
        "exp": now + 300,
        "iat": now,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, private_key, algorithm="ES256", headers={"kid": td_key_id})


async def _fetch_new_token() -> str:
    global _cached_token, _token_expires_at, _inflight
    td_account_id = os.environ["TD_ACCOUNT_ID"]
    td_client_id  = os.environ["TD_CLIENT_ID"]
    try:
        print("🔑 [TalkdeskAuth] Fetching new access token...")
        assertion = _generate_jwt()

        resp = await _http_client.post(
            f"https://{td_account_id}.talkdeskid.com/oauth/token",
            data={
                "grant_type": "client_credentials",
                "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                "client_assertion": assertion,
                "client_id": td_client_id,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()

        _cached_token = resp.json()["access_token"]
        _token_expires_at = time.time() + 55 * 60  # 55 minutes
        print("✅ [TalkdeskAuth] Token acquired, cached for 55 minutes")
        return _cached_token
    finally:
        _inflight = None


async def get_talkdesk_token() -> str:
    global _inflight

    if _cached_token and time.time() < _token_expires_at:
        print("🔑 [TalkdeskAuth] Reusing cached token")
        return _cached_token

    if _inflight is not None and not _inflight.done():
        print("🔑 [TalkdeskAuth] Waiting for in-flight token request...")
        return await _inflight

    _inflight = asyncio.create_task(_fetch_new_token())
    return await _inflight
