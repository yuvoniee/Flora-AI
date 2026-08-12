/**
 * Module D — Google Calendar Integration
 *
 * Exposes a single normalized `getTodayEvents()` function that fetches
 * today's events from the user's primary Google Calendar.
 *
 * Requirements (§6):
 * - Normalized output: CalendarEvent[]
 * - Read-only scope: `calendar.readonly` (single calendar)
 * - OAuth tokens stored in OS keychain only (§11): never in SQLite or a plaintext file
 * - Respects rate limits via 10-minute in-memory caching
 * - Error handling: any failure returns [] (never throws uncaught)
 * - Expired/revoked token → sets `authState.needsReconnect = true` for UI to surface
 *
 * OAuth architecture (RFC 8252 — desktop apps):
 * - PKCE Authorization Code flow (no client_secret needed for installed apps)
 * - Loopback redirect (http://localhost:PORT) for the auth code
 * - Token exchange and refresh are HTTP-only (no browser for refresh)
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;       // summary field from GCal
  start: string;       // ISO 8601 datetime
  end: string;         // ISO 8601 datetime
  location?: string;
  url?: string;        // htmlLink from GCal
  allDay: boolean;     // true if date-only (no time component)
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;   // Unix timestamp ms when accessToken expires
}

export interface CalendarAuthState {
  needsReconnect: boolean;  // true when token is expired/revoked with no refresh path
  reason?: string;
}

export interface CalendarOptions {
  ttlMs?: number;          // cache TTL (default 10 min)
  forceRefresh?: boolean;  // bypass cache
  timeoutMs?: number;      // fetch timeout ms (default 8000)
}

// ── Constants ─────────────────────────────────────────────────────────

export const GOOGLE_CALENDAR_API =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DEFAULT_TTL_MS = 10 * 60 * 1000;  // 10 minutes (§6 rate limit requirement)
const DEFAULT_TIMEOUT_MS = 8_000;

// ── Auth state (module-level, observable by UI) ────────────────────────

export const authState: CalendarAuthState = { needsReconnect: false };

// ── In-memory cache ────────────────────────────────────────────────────

interface CacheEntry {
  events: CalendarEvent[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

// ── Token provider injection (allows OS-keychain in CLI / Tauri) ───────

/**
 * Token provider interface — implementations live outside this module:
 * - CLI path: `keytar` (wraps OS Credential Manager / Keychain / libsecret)
 * - Tauri path: Tauri keychain command via IPC
 *
 * This keeps `calendar.ts` free of any native-module dependency so it
 * remains unit-testable with mock providers.
 */
export interface TokenProvider {
  getTokens(): Promise<OAuthTokens | null>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  deleteTokens(): Promise<void>;
}

let tokenProvider: TokenProvider | null = null;

/** Register the token provider before calling `getTodayEvents()`. */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

// ── OAuth helpers ─────────────────────────────────────────────────────

/** Build the Google Calendar API URL for today's events. */
export function buildCalendarUrl(): string {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  return `${GOOGLE_CALENDAR_API}?${params}`;
}

/** Returns true if the access token is expired (with 60s buffer). */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  return Date.now() >= tokens.expiresAt - 60_000;
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Returns updated tokens on success, null on failure.
 */
export async function refreshAccessToken(
  tokens: OAuthTokens,
  clientId: string,
  customFetch: typeof fetch = fetch,
): Promise<OAuthTokens | null> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    });

    const response = await customFetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      console.warn(`[Flora/calendar] Token refresh failed: HTTP ${response.status}`);
      return null;
    }

    const json = await response.json();
    if (!json.access_token) {
      console.warn('[Flora/calendar] Token refresh response missing access_token');
      return null;
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? tokens.refreshToken, // Google may not always return a new refresh token
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  } catch (err: any) {
    console.warn(`[Flora/calendar] Token refresh error: ${err?.message}`);
    return null;
  }
}

// ── Normalization ─────────────────────────────────────────────────────

/** Normalize a raw Google Calendar API event item into a CalendarEvent. */
export function normalizeEvent(raw: any): CalendarEvent | null {
  if (!raw || !raw.id || !raw.summary) return null;

  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime);

  const start = raw.start?.dateTime ?? raw.start?.date;
  const end = raw.end?.dateTime ?? raw.end?.date;

  if (!start || !end) return null;

  return {
    id: raw.id,
    title: raw.summary,
    start,
    end,
    location: raw.location ?? undefined,
    url: raw.htmlLink ?? undefined,
    allDay,
  };
}

// ── Main normalized function ──────────────────────────────────────────

/**
 * Fetch today's Google Calendar events, normalized.
 *
 * Returns `CalendarEvent[]` on success (may be empty).
 * Returns `[]` on any failure — never throws uncaught (§6 error handling).
 *
 * Sets `authState.needsReconnect = true` when token is gone/invalid with
 * no refresh path, so the UI can surface a "Reconnect Google Calendar" prompt.
 */
export async function getTodayEvents(
  options: CalendarOptions = {},
  clientId?: string,
  customFetch: typeof fetch = fetch,
): Promise<CalendarEvent[]> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const forceRefresh = options.forceRefresh ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const now = Date.now();

  // Return cached result if valid
  if (!forceRefresh && cache && (now - cache.fetchedAt) < ttlMs) {
    return cache.events;
  }

  // Require a registered token provider
  if (!tokenProvider) {
    console.warn('[Flora/calendar] No token provider registered. Call setTokenProvider() first.');
    authState.needsReconnect = true;
    authState.reason = 'no_provider';
    return [];
  }

  let tokens: OAuthTokens | null = null;

  try {
    tokens = await tokenProvider.getTokens();
  } catch (err: any) {
    console.warn(`[Flora/calendar] Failed to read tokens from keychain: ${err?.message}`);
    return [];
  }

  if (!tokens) {
    authState.needsReconnect = true;
    authState.reason = 'no_tokens';
    return [];
  }

  // Refresh access token if expired
  if (isTokenExpired(tokens)) {
    if (!clientId) {
      console.warn('[Flora/calendar] Token expired but no clientId provided for refresh');
      authState.needsReconnect = true;
      authState.reason = 'expired_no_client_id';
      return [];
    }

    const refreshed = await refreshAccessToken(tokens, clientId, customFetch);
    if (!refreshed) {
      authState.needsReconnect = true;
      authState.reason = 'refresh_failed';
      return [];
    }

    tokens = refreshed;
    try {
      await tokenProvider.saveTokens(tokens);
    } catch (err: any) {
      console.warn(`[Flora/calendar] Failed to save refreshed tokens: ${err?.message}`);
      // Non-fatal — continue with the in-memory refreshed tokens
    }
  }

  // Fetch events
  const url = buildCalendarUrl();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await customFetch(url, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.status === 401) {
      // Token was rejected by Google (revoked, invalid, or expired with wrong clock)
      console.warn('[Flora/calendar] Access token rejected (401) — needs reconnect');
      authState.needsReconnect = true;
      authState.reason = 'token_rejected';
      return [];
    }

    if (!response.ok) {
      console.warn(`[Flora/calendar] Calendar API returned HTTP ${response.status}`);
      return cache ? cache.events : [];  // stale cache fallback
    }

    const json = await response.json();
    const items: CalendarEvent[] = (json?.items ?? [])
      .map(normalizeEvent)
      .filter((e: CalendarEvent | null): e is CalendarEvent => e !== null);

    // Clear reconnect flag on successful fetch
    authState.needsReconnect = false;
    authState.reason = undefined;

    cache = { events: items, fetchedAt: now };
    return items;
  } catch (err: any) {
    console.warn(`[Flora/calendar] Fetch error: ${err?.message}`);
    return cache ? cache.events : [];  // stale cache or empty on failure
  }
}

// ── Cache helpers ─────────────────────────────────────────────────────

export function clearCalendarCache(): void {
  cache = null;
}

export function getCalendarCacheState(): { cached: boolean; ageMs?: number; eventCount?: number } {
  if (!cache) return { cached: false };
  return {
    cached: true,
    ageMs: Date.now() - cache.fetchedAt,
    eventCount: cache.events.length,
  };
}
