/**
 * Module D — Spotify Integration
 *
 * Exposes a single normalized `getNowPlaying()` function that reads the
 * user's current Spotify playback state.
 *
 * Requirements (§6):
 * - Scope: `user-read-playback-state` (read-only — no control)
 * - Normalized output: SpotifyTrack | null  (null = nothing playing or error)
 * - OAuth tokens stored in OS keychain only (§11) — same TokenProvider
 *   interface as calendar.ts
 * - 30-second in-memory cache (playback state changes fast)
 * - Error handling: any failure returns null (never throws uncaught)
 * - Expired/revoked token → sets authState.needsReconnect = true
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface SpotifyTrack {
  id: string;
  title: string;        // track name
  artist: string;       // primary artist name
  album: string;        // album name
  durationMs: number;   // track duration
  progressMs: number;   // current playback position
  isPlaying: boolean;   // false when paused
  url: string;          // open.spotify.com link
}

export interface SpotifyAuthState {
  needsReconnect: boolean;
  reason?: string;
}

export interface SpotifyOptions {
  ttlMs?: number;           // cache TTL (default 30 seconds)
  forceRefresh?: boolean;
  timeoutMs?: number;       // fetch timeout ms (default 5000)
}

// ── Re-use the TokenProvider interface (same shape as calendar.ts) ─────

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;   // Unix ms
}

export interface TokenProvider {
  getTokens(): Promise<OAuthTokens | null>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  deleteTokens(): Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────

export const SPOTIFY_NOW_PLAYING_URL =
  'https://api.spotify.com/v1/me/player/currently-playing';

export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

const DEFAULT_TTL_MS = 30 * 1000;      // 30 seconds — playback changes fast
const DEFAULT_TIMEOUT_MS = 5_000;

// ── Auth state ─────────────────────────────────────────────────────────

export const authState: SpotifyAuthState = { needsReconnect: false };

// ── Token provider (injectable) ────────────────────────────────────────

let tokenProvider: TokenProvider | null = null;

export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

// ── In-memory cache ────────────────────────────────────────────────────

interface CacheEntry {
  track: SpotifyTrack | null;  // null = confirmed nothing playing
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

// ── OAuth helpers ──────────────────────────────────────────────────────

export function isTokenExpired(tokens: OAuthTokens): boolean {
  return Date.now() >= tokens.expiresAt - 60_000;
}

/**
 * Refresh an expired Spotify access token.
 * Spotify PKCE refresh uses the refresh_token with a new code_verifier — but
 * for the token-refresh endpoint specifically, Spotify accepts the plain
 * refresh_token grant without requiring client_secret when the original flow
 * used PKCE. Returns updated tokens or null on failure.
 */
export async function refreshAccessToken(
  tokens: OAuthTokens,
  clientId: string,
  customFetch: typeof fetch = fetch,
): Promise<OAuthTokens | null> {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId,
    });

    const response = await customFetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      console.warn(`[Flora/spotify] Token refresh failed: HTTP ${response.status}`);
      return null;
    }

    const json = await response.json();
    if (!json.access_token) {
      console.warn('[Flora/spotify] Token refresh response missing access_token');
      return null;
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  } catch (err: any) {
    console.warn(`[Flora/spotify] Token refresh error: ${err?.message}`);
    return null;
  }
}

// ── Normalization ──────────────────────────────────────────────────────

/** Normalize a raw Spotify currently-playing API response into SpotifyTrack. */
export function normalizeTrack(raw: any): SpotifyTrack | null {
  // Guard: not a track (could be podcast/episode)
  if (!raw || raw.currently_playing_type !== 'track') return null;

  const item = raw.item;
  if (!item || !item.id || !item.name) return null;

  const primaryArtist = item.artists?.[0]?.name ?? 'Unknown Artist';
  const album = item.album?.name ?? 'Unknown Album';
  const url = item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`;

  return {
    id: item.id,
    title: item.name,
    artist: primaryArtist,
    album,
    durationMs: item.duration_ms ?? 0,
    progressMs: raw.progress_ms ?? 0,
    isPlaying: raw.is_playing ?? false,
    url,
  };
}

// ── Main normalized function ───────────────────────────────────────────

/**
 * Get the currently playing Spotify track, normalized.
 *
 * Returns `SpotifyTrack` when something is playing/paused.
 * Returns `null` when nothing is active, player is off, or on any error.
 * Never throws uncaught exceptions (§6 error handling).
 *
 * Sets `authState.needsReconnect = true` on 401/403 for UI surfacing.
 */
export async function getNowPlaying(
  options: SpotifyOptions = {},
  clientId?: string,
  customFetch: typeof fetch = fetch,
): Promise<SpotifyTrack | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const forceRefresh = options.forceRefresh ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = Date.now();

  // Return cached result if valid
  if (!forceRefresh && cache && (now - cache.fetchedAt) < ttlMs) {
    return cache.track;
  }

  if (!tokenProvider) {
    console.warn('[Flora/spotify] No token provider registered. Call setTokenProvider() first.');
    authState.needsReconnect = true;
    authState.reason = 'no_provider';
    return null;
  }

  let tokens: OAuthTokens | null = null;

  try {
    tokens = await tokenProvider.getTokens();
  } catch (err: any) {
    console.warn(`[Flora/spotify] Failed to read tokens from keychain: ${err?.message}`);
    return null;
  }

  if (!tokens) {
    authState.needsReconnect = true;
    authState.reason = 'no_tokens';
    return null;
  }

  // Refresh if expired
  if (isTokenExpired(tokens)) {
    if (!clientId) {
      console.warn('[Flora/spotify] Token expired but no clientId provided for refresh');
      authState.needsReconnect = true;
      authState.reason = 'expired_no_client_id';
      return null;
    }

    const refreshed = await refreshAccessToken(tokens, clientId, customFetch);
    if (!refreshed) {
      authState.needsReconnect = true;
      authState.reason = 'refresh_failed';
      return null;
    }

    tokens = refreshed;
    try {
      await tokenProvider.saveTokens(tokens);
    } catch (err: any) {
      console.warn(`[Flora/spotify] Failed to save refreshed tokens: ${err?.message}`);
      // Non-fatal
    }
  }

  // Fetch now playing
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await customFetch(SPOTIFY_NOW_PLAYING_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: controller.signal,
    });

    clearTimeout(timer);

    // 204 = no content (nothing playing) — valid, not an error
    if (response.status === 204) {
      authState.needsReconnect = false;
      cache = { track: null, fetchedAt: now };
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      console.warn(`[Flora/spotify] Auth rejected (${response.status}) — needs reconnect`);
      authState.needsReconnect = true;
      authState.reason = 'token_rejected';
      return null;
    }

    if (!response.ok) {
      console.warn(`[Flora/spotify] Spotify API returned HTTP ${response.status}`);
      return cache ? cache.track : null;
    }

    const json = await response.json();
    const track = normalizeTrack(json);

    authState.needsReconnect = false;
    authState.reason = undefined;
    cache = { track, fetchedAt: now };
    return track;
  } catch (err: any) {
    console.warn(`[Flora/spotify] Fetch error: ${err?.message}`);
    return cache ? cache.track : null;
  }
}

// ── Cache helpers ──────────────────────────────────────────────────────

export function clearSpotifyCache(): void {
  cache = null;
}

export function getSpotifyCacheState(): { cached: boolean; ageMs?: number } {
  if (!cache) return { cached: false };
  return { cached: true, ageMs: Date.now() - cache.fetchedAt };
}
