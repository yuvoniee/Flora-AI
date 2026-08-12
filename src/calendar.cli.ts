/**
 * Module D — Google Calendar Standalone CLI Runner
 *
 * OAuth PKCE flow with OS keychain token storage (keytar).
 * Tests the full path: auth → token → fetch → normalize.
 *
 * Usage:
 *   npx tsx src/calendar.cli.ts                     # fetch today's events (auth if needed)
 *   npx tsx src/calendar.cli.ts --revoke            # revoke/delete stored tokens
 *   npx tsx src/calendar.cli.ts --test-failure       # simulate network failure (§6 acceptance)
 *
 * Configuration:
 *   Set GOOGLE_CLIENT_ID env var (OAuth 2.0 client ID from Google Cloud Console,
 *   type: Desktop app — no client_secret required for PKCE desktop apps).
 *
 * §11 compliance:
 *   Tokens stored in OS keychain only (Windows: Credential Manager,
 *   macOS: Keychain, Linux: libsecret via keytar). Never written to disk.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  getTodayEvents,
  setTokenProvider,
  refreshAccessToken,
  isTokenExpired,
  authState,
  getCalendarCacheState,
  OAuthTokens,
  TokenProvider,
} from './calendar.js';

const execAsync = promisify(exec);

// ── Config ────────────────────────────────────────────────────────────

const KEYTAR_SERVICE = 'flora-calendar';
const KEYTAR_ACCOUNT = 'oauth-tokens';
const OAUTH_REDIRECT_PORT = 4242;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/oauth/callback`;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';

// ── Keytar token provider (OS keychain) ───────────────────────────────

async function getKeytar() {
  try {
    // Dynamic import to avoid bundler issues — keytar is a native CJS module
    const { default: keytar } = await import('keytar') as any;
    return keytar;
  } catch (e: any) {
    console.error('[Flora/calendar] keytar not available:', e.message);
    process.exit(1);
  }
}

function makeKeytarProvider(keytar: any): TokenProvider {
  return {
    async getTokens(): Promise<OAuthTokens | null> {
      const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async saveTokens(tokens: OAuthTokens): Promise<void> {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, JSON.stringify(tokens));
    },
    async deleteTokens(): Promise<void> {
      await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    },
  };
}

// ── PKCE helpers ──────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── OS browser open (cross-platform) ─────────────────────────────────

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      await execAsync(`start "" "${url}"`);
    } else if (platform === 'darwin') {
      await execAsync(`open "${url}"`);
    } else {
      await execAsync(`xdg-open "${url}"`);
    }
  } catch (e: any) {
    console.log(`\nCould not open browser automatically. Please visit:\n  ${url}\n`);
  }
}

// ── Loopback OAuth server ─────────────────────────────────────────────

/**
 * Starts a local HTTP server to capture the OAuth authorization code.
 * This is the RFC 8252 recommended approach for desktop/installed apps.
 */
function waitForAuthCode(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/oauth/callback')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://localhost:${OAUTH_REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authorization failed: ${error}</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Missing code or state.</h2></body></html>');
        server.close();
        reject(new Error('Missing code or state in OAuth callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body>
          <h2>✅ Flora connected to Google Calendar!</h2>
          <p>You can close this tab and return to the terminal.</p>
        </body></html>
      `);
      server.close();
      resolve({ code, state });
    });

    server.listen(OAUTH_REDIRECT_PORT, '127.0.0.1', () => {
      // Server is ready
    });

    server.on('error', (err) => {
      reject(err);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out (2 min)'));
    }, 2 * 60 * 1000);
  });
}

// ── Token exchange ────────────────────────────────────────────────────

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  clientId: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token exchange failed: HTTP ${response.status} — ${err}`);
  }

  const json = await response.json();

  if (!json.access_token || !json.refresh_token) {
    throw new Error(`Token exchange response missing tokens: ${JSON.stringify(json)}`);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

// ── OAuth flow ────────────────────────────────────────────────────────

async function runOAuthFlow(clientId: string, provider: TokenProvider): Promise<void> {
  console.log('\n🔐 Starting Google Calendar OAuth flow (PKCE)...');

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent', // ensure refresh_token is returned
  });

  const authUrl = `${GOOGLE_AUTH_URL}?${authParams.toString()}`;

  console.log('Opening browser for Google authorization...');
  await openBrowser(authUrl);

  console.log(`Waiting for OAuth callback on http://localhost:${OAUTH_REDIRECT_PORT}...`);
  const { code, state: returnedState } = await waitForAuthCode();

  if (returnedState !== state) {
    throw new Error('OAuth state mismatch — possible CSRF attempt');
  }

  console.log('Exchanging authorization code for tokens...');
  const tokens = await exchangeCodeForTokens(code, codeVerifier, clientId);

  await provider.saveTokens(tokens);
  console.log('✅ Tokens stored securely in OS keychain (§11 compliant)');
  console.log(`   Access token expires: ${new Date(tokens.expiresAt).toLocaleString()}`);
}

// ── Main CLI ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldRevoke = args.includes('--revoke');
  const testFailure = args.includes('--test-failure');

  const keytar = await getKeytar();
  const provider = makeKeytarProvider(keytar);
  setTokenProvider(provider);

  const clientId = process.env.GOOGLE_CLIENT_ID;

  // ── Revoke mode ───────────────────────────────────────────────────
  if (shouldRevoke) {
    console.log('Revoking stored Google Calendar tokens from OS keychain...');
    await provider.deleteTokens();
    console.log('✅ Tokens deleted from keychain (§11: real delete, not a flag)');
    return;
  }

  // ── Simulate network failure (§6 acceptance test) ─────────────────
  if (testFailure) {
    console.log('\n=== Testing §6 error handling: simulated network failure ===\n');

    const brokenFetch: typeof fetch = async () => {
      throw new Error('Simulated: network is down');
    };

    const events = await getTodayEvents({}, clientId, brokenFetch);
    console.log(`Result: ${JSON.stringify(events)}`);
    console.log(events.length === 0
      ? '✅ Correct — returned [] without throwing (§6 fallback requirement met)'
      : '❌ FAIL — expected []'
    );
    console.log(`authState.needsReconnect: ${authState.needsReconnect}`);
    return;
  }

  // ── Main fetch flow ───────────────────────────────────────────────
  console.log('=== Flora Calendar Integration (Module D Standalone CLI) ===\n');

  // Check for existing tokens
  let tokens = await provider.getTokens();

  if (!tokens) {
    if (!clientId) {
      console.error(
        '❌ No stored tokens and GOOGLE_CLIENT_ID env var not set.\n' +
        '   Set GOOGLE_CLIENT_ID=<your-oauth-client-id> and re-run to authenticate.\n' +
        '   Get a client ID from Google Cloud Console → APIs & Services → Credentials\n' +
        '   → Create credentials → OAuth 2.0 Client ID → Desktop app'
      );
      process.exit(1);
    }

    await runOAuthFlow(clientId, provider);
    tokens = await provider.getTokens();
  } else if (isTokenExpired(tokens) && clientId) {
    console.log('Access token expired — refreshing...');
    const refreshed = await refreshAccessToken(tokens, clientId);
    if (refreshed) {
      await provider.saveTokens(refreshed);
      console.log('✅ Token refreshed and saved to keychain');
    } else {
      console.warn('⚠️  Refresh failed — re-running OAuth flow');
      await runOAuthFlow(clientId, provider);
    }
  }

  // Fetch events
  console.log('\nFetching today\'s calendar events...');
  const start = Date.now();
  const events = await getTodayEvents({}, clientId);
  const elapsed = Date.now() - start;

  if (authState.needsReconnect) {
    console.log(`\n⚠️  Auth issue: ${authState.reason}`);
    console.log('   Re-run with GOOGLE_CLIENT_ID set to re-authenticate.');
    return;
  }

  console.log(`\n✅ Fetched ${events.length} event(s) in ${elapsed}ms\n`);

  if (events.length === 0) {
    console.log('   (No events today, or calendar is empty)');
  } else {
    events.forEach((evt, i) => {
      const time = evt.allDay
        ? 'All day'
        : `${new Date(evt.start).toLocaleTimeString()} – ${new Date(evt.end).toLocaleTimeString()}`;
      console.log(`   ${i + 1}. ${evt.title}`);
      console.log(`      🕐 ${time}`);
      if (evt.location) console.log(`      📍 ${evt.location}`);
      if (evt.url) console.log(`      🔗 ${evt.url}`);
    });
  }

  console.log(`\n   Cache: ${JSON.stringify(getCalendarCacheState())}`);
}


main().catch((err) => {
  console.error('\n❌ Unexpected error in calendar CLI:', err.message);
  process.exit(1);
});
