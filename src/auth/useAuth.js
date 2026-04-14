import { useState, useEffect } from 'react';
import { setApiToken } from '../data/apiFetch.js';

const TOKEN_KEY  = 'db_access_token';
const EXPIRY_KEY = 'db_token_expiry';
const VERIFIER_KEY = 'db_pkce_verifier';
const REDIRECT_KEY = 'db_redirect_uri';

function generateVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function exchangeCode(code, codeVerifier, redirectUri) {
  const res = await fetch('/api/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier, redirectUri }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json();
}

export function useAuth() {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);

  useEffect(() => {
    // In local dev, skip auth entirely
    if (import.meta.env.DEV) {
      setAuthenticated(true);
      setLoading(false);
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');

    if (code) {
      // Returning from Databricks OAuth redirect
      const verifier    = sessionStorage.getItem(VERIFIER_KEY);
      const redirectUri = sessionStorage.getItem(REDIRECT_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(REDIRECT_KEY);
      window.history.replaceState({}, '', window.location.pathname);

      exchangeCode(code, verifier, redirectUri)
        .then(({ access_token, expires_in }) => {
          sessionStorage.setItem(TOKEN_KEY,  access_token);
          sessionStorage.setItem(EXPIRY_KEY, String(Date.now() + expires_in * 1000));
          setApiToken(access_token);
          setAuthenticated(true);
        })
        .catch(err => {
          console.error('[Auth] Token exchange error:', err);
          setError('Authentication failed. Please try again.');
          setAuthenticated(false);
        })
        .finally(() => setLoading(false));
      return;
    }

    // Restore existing session
    const token  = sessionStorage.getItem(TOKEN_KEY);
    const expiry = sessionStorage.getItem(EXPIRY_KEY);
    if (token && expiry && Date.now() < parseInt(expiry)) {
      setApiToken(token);
      setAuthenticated(true);
    }
    setLoading(false);
  }, []);

  async function login() {
    setError(null);
    const config = await fetch('/api/auth/config').then(r => r.json());
    const verifier   = generateVerifier();
    const challenge  = await generateChallenge(verifier);
    const redirectUri = config.redirectUri;

    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(REDIRECT_KEY, redirectUri);

    const authUrl = new URL(`https://${config.host}/oidc/v1/authorize`);
    authUrl.searchParams.set('client_id',             config.clientId);
    authUrl.searchParams.set('response_type',         'code');
    authUrl.searchParams.set('redirect_uri',          redirectUri);
    authUrl.searchParams.set('scope',                 'all-apis offline_access');
    authUrl.searchParams.set('code_challenge',        challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    window.location.href = authUrl.toString();
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
    setApiToken(null);
    setAuthenticated(false);
  }

  return { authenticated, loading, error, login, logout };
}
