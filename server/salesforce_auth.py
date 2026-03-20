"""
salesforce_auth.py
Salesforce JWT OAuth2 bearer flow — port of salesforceAuth.js

Required env vars:
  SF_USERNAME   — Salesforce username
  SF_CLIENT_ID  — Connected App consumer key
  SF_PRIVATE_KEY — RSA private key PEM content (with \\n escapes) or file path
  SF_LOGIN_URL  — e.g. https://login.salesforce.com
"""

import os
import time
import jwt  # PyJWT
import httpx

_cached_token: str | None = None
_token_expires_at: float = 0.0
_http_client = httpx.AsyncClient()


def _load_private_key() -> str:
    raw = os.environ.get("SF_PRIVATE_KEY", "")
    if not raw:
        raise ValueError("SF_PRIVATE_KEY env var is not set")
    if raw.startswith("-----BEGIN"):
        # Direct PEM content — replace escaped newlines
        return raw.replace("\\n", "\n")
    # File path — resolve relative to this file's directory
    key_path = os.path.join(os.path.dirname(__file__), raw)
    with open(key_path) as f:
        return f.read()


def _generate_jwt() -> str:
    sf_username  = os.environ["SF_USERNAME"]
    sf_client_id = os.environ["SF_CLIENT_ID"]
    sf_login_url = os.environ["SF_LOGIN_URL"]
    private_key  = _load_private_key()

    now = int(time.time())
    payload = {
        "iss": sf_client_id,
        "sub": sf_username,
        "aud": sf_login_url,
        "exp": now + 300,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


async def get_salesforce_token() -> str:
    global _cached_token, _token_expires_at

    if _cached_token and time.time() < _token_expires_at:
        return _cached_token

    print("🔑 [SalesforceAuth] Fetching new access token...")
    sf_login_url = os.environ["SF_LOGIN_URL"]
    assertion = _generate_jwt()

    resp = await _http_client.post(
        f"{sf_login_url}/services/oauth2/token",
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    resp.raise_for_status()

    _cached_token = resp.json()["access_token"]
    _token_expires_at = time.time() + 110 * 60  # 110 minutes
    print("✅ [SalesforceAuth] Token acquired, cached for 110 minutes")
    return _cached_token
