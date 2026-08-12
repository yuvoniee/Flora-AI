/**
 * Module D — Spotify Standalone CLI Runner
 *
 * OAuth PKCE flow with OS keychain token storage (keytar).
 * Tests the full path: auth → token → fetch → normalize.
 *
 * Usage:
 *   npx tsx src/spotify.cli.ts                    # get now playing (auth if needed)
 *   npx tsx src/spotify.cli.ts --revoke           # delete stored tokens from keychain
 *   npx tsx src/spotify.cli.ts --test-failure     # simulated network failure (§6 acceptance)
 *
 * Configuration:
 *   Set SPOTIFY_CLIENT_ID env var (OAuth 2.0 client ID from Spotify Developer Dashboard,
 *   App type: Web API. Redirect URI to register: http://localhost:4244/callback)
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
  getNowPlaying,
  setTokenProvider,
  isTokenExpired,
  refreshAccessToken,
  authState,
  getSpotifyCacheState,
  OAuthTokens,
  TokenProvider,
} from './spotify.js';

const execAsync = promisify(exec);

// ── Config ─────────────────────────────────────────────────────────────

const KEYTAR_SERVICE = 'flora-spotify';
const KEYTAR_ACCOUNT = 'oauth-tokens';
const OAUTH_REDIRECT_PORT = 4244;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/callback`;

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SCOPES = 'user-read-playback-state';

// ── Keytar token provider ──────────────────────────────────────────────

async function getKeytar() {
  try {
    const { default: keytar } = await import('keytar') as any;
    return keytar;
  } catch (e: any) {
    console.error('[Flora/spotify] keytar not available:', e.message);
    process.exit(1);
  }
}

function makeKeytarProvider(keytar: any): TokenProvider {
  return {
    async getTokens(): Promise<OAuthTokens | null> {
      const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async saveTokens(tokens: OAuthTokens): Promise<void> {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, JSON.stringify(tokens));
    },
    async deleteTokens(): Promise<void> {
      await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    },
  };
}

// ── PKCE helpers ───────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Browser open ───────────────────────────────────────────────────────

async function openBrowser(url: string): Promise<void> {
  try {
    const platform = process.platform;
    if (platform === 'win32') await execAsync(`start "" "${url}"`);
    else if (platform === 'darwin') await execAsync(`open "${url}"`);
    else await execAsync(`xdg-open "${url}"`);
  } catch {
    console.log(`\nCould not open browser automatically. Please visit:\n  ${url}\n`);
  }
}

// ── Loopback OAuth server ──────────────────────────────────────────────

function waitForAuthCode(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) { res.writeHead(404); res.end(); return; }

      const url = new URL(req.url, `http://localhost:${OAUTH_REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Auth failed: ${error}</h2><p>Close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`Spotify OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Invalid callback.</h2></body></html>');
        server.close();
        reject(new Error('Invalid OAuth callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>
        <h2>✅ Flora connected to Spotify!</h2>
        <p>You can close this tab and return to the terminal.</p>
      </body></html>`);
      server.close();
      resolve(code);
    });

    server.listen(OAUTH_REDIRECT_PORT, '127.0.0.1');
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('OAuth flow timed out')); }, 2 * 60 * 1000);
  });
}

// ── Token exchange ─────────────────────────────────────────────────────

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

  const response = await fetch('https://accounts.spotify.com/api/token', {
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
    throw new Error(`Missing tokens in exchange response: ${JSON.stringify(json)}`);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

// ── OAuth PKCE flow ────────────────────────────────────────────────────

async function runOAuthFlow(clientId: string, provider: TokenProvider): Promise<void> {
  console.log('\n🔐 Starting Spotify OAuth flow (PKCE)...');

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  const authParams = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
    scope: SCOPES,
  });

  const authUrl = `${SPOTIFY_AUTH_URL}?${authParams.toString()}`;
  console.log('Opening browser for Spotify authorization...');
  await openBrowser(authUrl);

  console.log(`Waiting for OAuth callback on http://localhost:${OAUTH_REDIRECT_PORT}...`);
  const code = await waitForAuthCode(state);

  console.log('Exchanging authorization code for tokens...');
  const tokens = await exchangeCodeForTokens(code, codeVerifier, clientId);

  await provider.saveTokens(tokens);
  console.log('✅ Tokens stored securely in OS keychain (§11 compliant)');
  console.log(`   Access token expires: ${new Date(tokens.expiresAt).toLocaleString()}`);
}

// ── Main CLI ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldRevoke = args.includes('--revoke');
  const testFailure = args.includes('--test-failure');

  const keytar = await getKeytar();
  const provider = makeKeytarProvider(keytar);
  setTokenProvider(provider);

  const clientId = process.env.SPOTIFY_CLIENT_ID;

  // ── Revoke mode ────────────────────────────────────────────────────
  if (shouldRevoke) {
    await provider.deleteTokens();
    console.log('✅ Spotify tokens deleted from OS keychain (§11: real delete, not a flag)');
    return;
  }

  // ── §6 acceptance: simulated network failure ───────────────────────
  if (testFailure) {
    console.log('\n=== Testing §6 error handling: simulated network failure ===\n');

    const brokenFetch: typeof fetch = async () => {
      throw new Error('Simulated: network is down');
    };

    const track = await getNowPlaying({}, clientId, brokenFetch);
    console.log(`Result: ${JSON.stringify(track)}`);
    console.log(track === null
      ? '✅ Correct — returned null without throwing (§6 fallback requirement met)'
      : '❌ FAIL — expected null'
    );
    console.log(`authState.needsReconnect: ${authState.needsReconnect}`);
    return;
  }

  // ── Main fetch flow ────────────────────────────────────────────────
  console.log('=== Flora Spotify Integration (Module D Standalone CLI) ===\n');

  let tokens = await provider.getTokens();

  if (!tokens) {
    if (!clientId) {
      console.error(
        '❌ No stored tokens and SPOTIFY_CLIENT_ID env var not set.\n' +
        '   Set SPOTIFY_CLIENT_ID=<your-client-id> and re-run to authenticate.\n' +
        '   Get a client ID from https://developer.spotify.com/dashboard\n' +
        '   → Create app → Add redirect URI: http://localhost:4244/callback'
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

  console.log('Fetching Spotify now playing...');
  const start = Date.now();
  const track = await getNowPlaying({}, clientId);
  const elapsed = Date.now() - start;

  if (authState.needsReconnect) {
    console.log(`\n⚠️  Auth issue: ${authState.reason}`);
    console.log('   Re-run with SPOTIFY_CLIENT_ID set to re-authenticate.');
    return;
  }

  if (track === null) {
    console.log(`\n✅ Fetch successful (${elapsed}ms) — nothing currently playing`);
  } else {
    console.log(`\n✅ Now playing (${elapsed}ms):\n`);
    console.log(`   🎵 Track   : ${track.title}`);
    console.log(`   🎤 Artist  : ${track.artist}`);
    console.log(`   💿 Album   : ${track.album}`);
    console.log(`   ▶️  Status  : ${track.isPlaying ? 'Playing' : 'Paused'}`);
    const progress = Math.round(track.progressMs / 1000);
    const duration = Math.round(track.durationMs / 1000);
    console.log(`   🕐 Progress: ${progress}s / ${duration}s`);
    console.log(`   🔗 URL     : ${track.url}`);
  }

  console.log(`\n   Cache: ${JSON.stringify(getSpotifyCacheState())}`);
}

main().catch((err) => {
  console.error('\n❌ Unexpected error in Spotify CLI:', err.message);
  process.exit(1);
});
