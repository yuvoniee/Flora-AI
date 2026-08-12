import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTodayEvents,
  setTokenProvider,
  clearCalendarCache,
  normalizeEvent,
  isTokenExpired,
  refreshAccessToken,
  buildCalendarUrl,
  authState,
  getCalendarCacheState,
  OAuthTokens,
  TokenProvider,
} from './calendar';

// ── Helpers ────────────────────────────────────────────────────────────

function makeTokens(expiresInMs = 3600 * 1000): OAuthTokens {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + expiresInMs,
  };
}

function mockProvider(tokens: OAuthTokens | null): TokenProvider & {
  saved: OAuthTokens | null;
  deleted: boolean;
} {
  const store = { saved: tokens, deleted: false };
  return {
    async getTokens() { return store.saved; },
    async saveTokens(t) { store.saved = t; },
    async deleteTokens() { store.deleted = true; store.saved = null; },
    get saved() { return store.saved; },
    get deleted() { return store.deleted; },
  };
}

function mockGCalResponse(events: any[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ kind: 'calendar#events', items: events }),
  });
}

const SAMPLE_RAW_EVENT = {
  id: 'evt-001',
  summary: 'Team Standup',
  start: { dateTime: '2026-08-12T10:00:00+05:30' },
  end: { dateTime: '2026-08-12T10:30:00+05:30' },
  location: 'Zoom',
  htmlLink: 'https://calendar.google.com/event?eid=evt-001',
};

const ALL_DAY_RAW_EVENT = {
  id: 'evt-002',
  summary: 'Project Deadline',
  start: { date: '2026-08-12' },
  end: { date: '2026-08-13' },
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('Module D — Google Calendar Integration', () => {
  beforeEach(() => {
    clearCalendarCache();
    authState.needsReconnect = false;
    authState.reason = undefined;
    vi.restoreAllMocks();
  });

  // ── normalizeEvent ────────────────────────────────────────────────────

  describe('normalizeEvent', () => {
    it('normalizes a standard timed event', () => {
      const event = normalizeEvent(SAMPLE_RAW_EVENT);
      expect(event).not.toBeNull();
      expect(event?.id).toBe('evt-001');
      expect(event?.title).toBe('Team Standup');
      expect(event?.start).toBe('2026-08-12T10:00:00+05:30');
      expect(event?.end).toBe('2026-08-12T10:30:00+05:30');
      expect(event?.location).toBe('Zoom');
      expect(event?.url).toBe('https://calendar.google.com/event?eid=evt-001');
      expect(event?.allDay).toBe(false);
    });

    it('normalizes an all-day event', () => {
      const event = normalizeEvent(ALL_DAY_RAW_EVENT);
      expect(event?.allDay).toBe(true);
      expect(event?.start).toBe('2026-08-12');
      expect(event?.title).toBe('Project Deadline');
    });

    it('returns null for malformed events (missing summary)', () => {
      expect(normalizeEvent({ id: 'x', start: { dateTime: 'y' }, end: { dateTime: 'z' } })).toBeNull();
    });

    it('returns null for null/undefined input', () => {
      expect(normalizeEvent(null)).toBeNull();
      expect(normalizeEvent(undefined)).toBeNull();
    });
  });

  // ── isTokenExpired ────────────────────────────────────────────────────

  describe('isTokenExpired', () => {
    it('returns false for a fresh token', () => {
      expect(isTokenExpired(makeTokens(3600 * 1000))).toBe(false);
    });

    it('returns true for a token expiring in <60s (buffer zone)', () => {
      expect(isTokenExpired(makeTokens(30 * 1000))).toBe(true);
    });

    it('returns true for an already-expired token', () => {
      expect(isTokenExpired(makeTokens(-1))).toBe(true);
    });
  });

  // ── buildCalendarUrl ──────────────────────────────────────────────────

  describe('buildCalendarUrl', () => {
    it('builds a URL with today start/end and required query params', () => {
      const url = buildCalendarUrl();
      expect(url).toContain('timeMin');
      expect(url).toContain('timeMax');
      expect(url).toContain('singleEvents=true');
      expect(url).toContain('orderBy=startTime');
    });
  });

  // ── getTodayEvents — Success Path ─────────────────────────────────────

  describe('getTodayEvents — success', () => {
    it('fetches and normalizes today\'s events', async () => {
      const provider = mockProvider(makeTokens());
      setTokenProvider(provider);
      const mockFetch = mockGCalResponse([SAMPLE_RAW_EVENT, ALL_DAY_RAW_EVENT]);

      const events = await getTodayEvents({}, undefined, mockFetch as any);

      expect(events).toHaveLength(2);
      expect(events[0].title).toBe('Team Standup');
      expect(events[1].title).toBe('Project Deadline');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(authState.needsReconnect).toBe(false);
    });

    it('returns an empty array when calendar has no events today', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const events = await getTodayEvents({}, undefined, mockGCalResponse([]) as any);
      expect(events).toEqual([]);
      expect(authState.needsReconnect).toBe(false);
    });
  });

  // ── getTodayEvents — Caching ──────────────────────────────────────────

  describe('getTodayEvents — caching', () => {
    it('caches results and does not re-fetch within TTL', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = mockGCalResponse([SAMPLE_RAW_EVENT]);

      const first = await getTodayEvents({}, undefined, mockFetch as any);
      const second = await getTodayEvents({}, undefined, mockFetch as any);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1); // only one network call
      expect(getCalendarCacheState().cached).toBe(true);
      expect(getCalendarCacheState().eventCount).toBe(1);
    });

    it('bypasses cache when forceRefresh is true', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = mockGCalResponse([SAMPLE_RAW_EVENT]);

      await getTodayEvents({}, undefined, mockFetch as any);
      await getTodayEvents({ forceRefresh: true }, undefined, mockFetch as any);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── getTodayEvents — Token Refresh ────────────────────────────────────

  describe('getTodayEvents — token refresh', () => {
    it('refreshes an expired token and retries the fetch', async () => {
      const expiredTokens = makeTokens(-1000); // already expired
      const provider = mockProvider(expiredTokens);
      setTokenProvider(provider);

      const refreshedTokens: OAuthTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 3600 * 1000,
      };

      const mockFetch = vi.fn()
        // First call: token refresh endpoint
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'new-access-token', expires_in: 3600 }),
        })
        // Second call: calendar events
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ items: [SAMPLE_RAW_EVENT] }),
        });

      const events = await getTodayEvents({}, 'test-client-id', mockFetch as any);

      expect(events).toHaveLength(1);
      expect(provider.saved?.accessToken).toBe('new-access-token'); // new token saved to keychain
      expect(authState.needsReconnect).toBe(false);
    });
  });

  // ── getTodayEvents — Error Handling / Fallbacks (§6) ─────────────────

  describe('getTodayEvents — error handling fallbacks', () => {
    it('returns [] and does not throw on network failure', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network is down'));

      const events = await getTodayEvents({}, undefined, mockFetch as any);

      expect(events).toEqual([]);
      // Must not throw — test passes if we reach here
    });

    it('returns [] and sets needsReconnect on 401 (revoked token)', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

      const events = await getTodayEvents({}, undefined, mockFetch as any);

      expect(events).toEqual([]);
      expect(authState.needsReconnect).toBe(true);
      expect(authState.reason).toBe('token_rejected');
    });

    it('returns [] and sets needsReconnect when no tokens in keychain', async () => {
      setTokenProvider(mockProvider(null)); // keychain returns null

      const events = await getTodayEvents({}, undefined, vi.fn() as any);

      expect(events).toEqual([]);
      expect(authState.needsReconnect).toBe(true);
      expect(authState.reason).toBe('no_tokens');
    });

    it('returns [] and sets needsReconnect when no provider is registered', async () => {
      setTokenProvider(null as any); // no provider

      const events = await getTodayEvents({}, undefined, vi.fn() as any);

      expect(events).toEqual([]);
      expect(authState.needsReconnect).toBe(true);
    });

    it('returns stale cache on HTTP 500 when cache exists', async () => {
      setTokenProvider(mockProvider(makeTokens()));

      // Populate cache with a successful fetch
      const mockFetchSuccess = mockGCalResponse([SAMPLE_RAW_EVENT]);
      await getTodayEvents({}, undefined, mockFetchSuccess as any);

      // Force refresh fails with 500
      const mockFetchFail = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const events = await getTodayEvents({ forceRefresh: true }, undefined, mockFetchFail as any);

      expect(events).toHaveLength(1); // stale cache returned
      expect(events[0].title).toBe('Team Standup');
    });

    it('returns [] on token refresh failure (sets needsReconnect)', async () => {
      setTokenProvider(mockProvider(makeTokens(-1))); // expired token

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
      });

      const events = await getTodayEvents({}, 'test-client-id', mockFetch as any);

      expect(events).toEqual([]);
      expect(authState.needsReconnect).toBe(true);
      expect(authState.reason).toBe('refresh_failed');
    });
  });
});
