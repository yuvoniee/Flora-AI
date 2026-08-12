import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getNowPlaying,
  setTokenProvider,
  clearSpotifyCache,
  getSpotifyCacheState,
  normalizeTrack,
  isTokenExpired,
  refreshAccessToken,
  authState,
  OAuthTokens,
  TokenProvider,
} from './spotify';

// ── Helpers ────────────────────────────────────────────────────────────

function makeTokens(expiresInMs = 3600 * 1000): OAuthTokens {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + expiresInMs,
  };
}

function mockProvider(tokens: OAuthTokens | null): TokenProvider & { saved: OAuthTokens | null } {
  const store = { saved: tokens };
  return {
    async getTokens() { return store.saved; },
    async saveTokens(t) { store.saved = t; },
    async deleteTokens() { store.saved = null; },
    get saved() { return store.saved; },
  };
}

const SAMPLE_RAW_NOW_PLAYING = {
  is_playing: true,
  progress_ms: 45000,
  currently_playing_type: 'track',
  item: {
    id: 'track-abc-123',
    name: 'Breathe',
    artists: [{ name: 'Pink Floyd' }, { name: 'Other' }],
    album: { name: 'The Dark Side of the Moon' },
    duration_ms: 163000,
    external_urls: { spotify: 'https://open.spotify.com/track/abc' },
  },
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('Module D — Spotify Integration', () => {
  beforeEach(() => {
    clearSpotifyCache();
    authState.needsReconnect = false;
    authState.reason = undefined;
    vi.restoreAllMocks();
  });

  // ── normalizeTrack ────────────────────────────────────────────────────

  describe('normalizeTrack', () => {
    it('normalizes a standard track response', () => {
      const track = normalizeTrack(SAMPLE_RAW_NOW_PLAYING);
      expect(track).not.toBeNull();
      expect(track?.id).toBe('track-abc-123');
      expect(track?.title).toBe('Breathe');
      expect(track?.artist).toBe('Pink Floyd');   // primary artist only
      expect(track?.album).toBe('The Dark Side of the Moon');
      expect(track?.durationMs).toBe(163000);
      expect(track?.progressMs).toBe(45000);
      expect(track?.isPlaying).toBe(true);
      expect(track?.url).toBe('https://open.spotify.com/track/abc');
    });

    it('returns null for podcast/episode (currently_playing_type !== track)', () => {
      const podcast = { ...SAMPLE_RAW_NOW_PLAYING, currently_playing_type: 'episode' };
      expect(normalizeTrack(podcast)).toBeNull();
    });

    it('returns null for null/missing input', () => {
      expect(normalizeTrack(null)).toBeNull();
      expect(normalizeTrack(undefined)).toBeNull();
    });

    it('returns null when item is missing', () => {
      expect(normalizeTrack({ currently_playing_type: 'track', item: null })).toBeNull();
    });

    it('uses fallback values for missing optional fields', () => {
      const minimal = {
        is_playing: false,
        progress_ms: 0,
        currently_playing_type: 'track',
        item: {
          id: 'x',
          name: 'Track',
          // no artists, album, or external_urls
        },
      };
      const track = normalizeTrack(minimal);
      expect(track).not.toBeNull();
      expect(track?.artist).toBe('Unknown Artist');
      expect(track?.album).toBe('Unknown Album');
      expect(track?.url).toContain('open.spotify.com/track/x');
    });
  });

  // ── isTokenExpired ────────────────────────────────────────────────────

  describe('isTokenExpired', () => {
    it('returns false for a fresh token', () => {
      expect(isTokenExpired(makeTokens(3600 * 1000))).toBe(false);
    });

    it('returns true for a token expiring within the 60s buffer', () => {
      expect(isTokenExpired(makeTokens(30 * 1000))).toBe(true);
    });

    it('returns true for an already-expired token', () => {
      expect(isTokenExpired(makeTokens(-1))).toBe(true);
    });
  });

  // ── getNowPlaying — success ───────────────────────────────────────────

  describe('getNowPlaying — success', () => {
    it('fetches and normalizes the current track', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SAMPLE_RAW_NOW_PLAYING,
      });

      const track = await getNowPlaying({}, undefined, mockFetch as any);

      expect(track).not.toBeNull();
      expect(track?.title).toBe('Breathe');
      expect(track?.artist).toBe('Pink Floyd');
      expect(authState.needsReconnect).toBe(false);
    });

    it('returns null when Spotify reports 204 (nothing playing) — valid state', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });

      const track = await getNowPlaying({}, undefined, mockFetch as any);

      expect(track).toBeNull();
      expect(authState.needsReconnect).toBe(false);
    });
  });

  // ── getNowPlaying — caching ───────────────────────────────────────────

  describe('getNowPlaying — caching', () => {
    it('caches result within TTL and does not re-fetch', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SAMPLE_RAW_NOW_PLAYING,
      });

      const t1 = await getNowPlaying({}, undefined, mockFetch as any);
      const t2 = await getNowPlaying({}, undefined, mockFetch as any);

      expect(t1?.title).toBe('Breathe');
      expect(t2?.title).toBe('Breathe');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(getSpotifyCacheState().cached).toBe(true);
    });

    it('bypasses cache on forceRefresh', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SAMPLE_RAW_NOW_PLAYING,
      });

      await getNowPlaying({}, undefined, mockFetch as any);
      await getNowPlaying({ forceRefresh: true }, undefined, mockFetch as any);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── getNowPlaying — token refresh ─────────────────────────────────────

  describe('getNowPlaying — token refresh', () => {
    it('refreshes expired token and retries the fetch', async () => {
      const provider = mockProvider(makeTokens(-1000)); // expired
      setTokenProvider(provider);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({    // refresh endpoint
          ok: true,
          json: async () => ({ access_token: 'new-token', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({    // now-playing endpoint
          ok: true,
          status: 200,
          json: async () => SAMPLE_RAW_NOW_PLAYING,
        });

      const track = await getNowPlaying({}, 'test-client-id', mockFetch as any);

      expect(track?.title).toBe('Breathe');
      expect(provider.saved?.accessToken).toBe('new-token');
      expect(authState.needsReconnect).toBe(false);
    });
  });

  // ── getNowPlaying — error fallbacks (§6) ─────────────────────────────

  describe('getNowPlaying — error handling fallbacks', () => {
    it('returns null and does not throw on network failure', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network down'));

      const track = await getNowPlaying({}, undefined, mockFetch as any);

      expect(track).toBeNull();
      // Must not throw — if we reach here the test passes
    });

    it('returns null and sets needsReconnect on 401', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

      const track = await getNowPlaying({}, undefined, mockFetch as any);

      expect(track).toBeNull();
      expect(authState.needsReconnect).toBe(true);
      expect(authState.reason).toBe('token_rejected');
    });

    it('returns null and sets needsReconnect on 403', async () => {
      setTokenProvider(mockProvider(makeTokens()));
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });

      const track = await getNowPlaying({}, undefined, mockFetch as any);

      expect(track).toBeNull();
      expect(authState.needsReconnect).toBe(true);
    });

    it('returns null when no tokens in keychain', async () => {
      setTokenProvider(mockProvider(null));
      const track = await getNowPlaying({}, undefined, vi.fn() as any);
      expect(track).toBeNull();
      expect(authState.needsReconnect).toBe(true);
      expect(authState.reason).toBe('no_tokens');
    });

    it('returns null when no provider registered', async () => {
      setTokenProvider(null as any);
      const track = await getNowPlaying({}, undefined, vi.fn() as any);
      expect(track).toBeNull();
      expect(authState.needsReconnect).toBe(true);
    });

    it('returns stale cache on transient HTTP 500', async () => {
      setTokenProvider(mockProvider(makeTokens()));

      const goodFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SAMPLE_RAW_NOW_PLAYING,
      });
      await getNowPlaying({}, undefined, goodFetch as any);

      const badFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const track = await getNowPlaying({ forceRefresh: true }, undefined, badFetch as any);

      expect(track?.title).toBe('Breathe'); // stale cache returned
    });

    it('returns null on token refresh failure', async () => {
      setTokenProvider(mockProvider(makeTokens(-1)));
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

      const track = await getNowPlaying({}, 'client-id', mockFetch as any);

      expect(track).toBeNull();
      expect(authState.needsReconnect).toBe(true);
      expect(authState.reason).toBe('refresh_failed');
    });
  });
});
