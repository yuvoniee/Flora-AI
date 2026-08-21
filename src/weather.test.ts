import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getWeather,
  geocodeCity,
  wmoToCondition,
  clearWeatherCache,
  clearGeocodeCache,
  getWeatherCacheState,
  WeatherData,
} from './weather';

describe('Module D — Weather Integration', () => {
  beforeEach(() => {
    clearWeatherCache();
    clearGeocodeCache();
    vi.restoreAllMocks();
  });

  describe('wmoToCondition mapping', () => {
    it('maps WMO codes correctly to human-readable conditions', () => {
      expect(wmoToCondition(0)).toBe('Clear');
      expect(wmoToCondition(1)).toBe('Partly Cloudy');
      expect(wmoToCondition(2)).toBe('Partly Cloudy');
      expect(wmoToCondition(3)).toBe('Overcast');
      expect(wmoToCondition(45)).toBe('Fog');
      expect(wmoToCondition(53)).toBe('Drizzle');
      expect(wmoToCondition(63)).toBe('Rain');
      expect(wmoToCondition(73)).toBe('Snow');
      expect(wmoToCondition(80)).toBe('Rain Showers');
      expect(wmoToCondition(85)).toBe('Snow Showers');
      expect(wmoToCondition(95)).toBe('Thunderstorm');
      expect(wmoToCondition(999)).toBe('Unknown');
    });
  });

  // ── Geocoding ───────────────────────────────────────────────────────────────

  describe('geocodeCity', () => {
    it('resolves a city name to lat/lon', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ latitude: 51.5074, longitude: -0.1278, name: 'London', country_code: 'GB' }],
        }),
      });

      const result = await geocodeCity('London', mockFetch as any);
      expect(result).not.toBeNull();
      expect(result!.lat).toBe(51.5074);
      expect(result!.lon).toBe(-0.1278);
      expect(result!.name).toBe('London');
      expect(result!.country).toBe('GB');
    });

    it('returns null when no results found', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      });

      const result = await geocodeCity('NonexistentCity12345', mockFetch as any);
      expect(result).toBeNull();
    });

    it('returns null on HTTP error (§6 — never throws)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const result = await geocodeCity('London', mockFetch as any);
      expect(result).toBeNull();
    });

    it('returns null on network failure (§6 — never throws)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('DNS failed'));
      const result = await geocodeCity('London', mockFetch as any);
      expect(result).toBeNull();
    });

    it('caches geocoding results in memory', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ latitude: 48.8566, longitude: 2.3522, name: 'Paris', country_code: 'FR' }],
        }),
      });

      await geocodeCity('Paris', mockFetch as any);
      await geocodeCity('Paris', mockFetch as any);
      expect(mockFetch).toHaveBeenCalledTimes(1); // second call uses cache
    });

    it('returns null for empty string', async () => {
      const mockFetch = vi.fn();
      const result = await geocodeCity('', mockFetch as any);
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── getWeather with city name ──────────────────────────────────────────────

  describe('getWeather with city option', () => {
    it('geocodes city name then fetches weather for those coordinates', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        if (url.includes('geocoding-api')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ latitude: 35.6762, longitude: 139.6503, name: 'Tokyo', country_code: 'JP' }],
            }),
          };
        }
        // Weather API
        return {
          ok: true,
          json: async () => ({
            current: { temperature_2m: 28.5, weather_code: 0 },
          }),
        };
      });

      const weather = await getWeather({ city: 'Tokyo' }, mockFetch as any);
      expect(weather).not.toBeNull();
      expect(weather!.temp).toBe(28.5);
      expect(weather!.condition).toBe('Clear');

      // Verify the weather URL used the geocoded coordinates
      const weatherUrl = calledUrls.find(u => u.includes('api.open-meteo.com/v1/forecast'));
      expect(weatherUrl).toContain('latitude=35.6762');
      expect(weatherUrl).toContain('longitude=139.6503');
    });

    it('falls back to default location when geocoding fails', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        if (url.includes('geocoding-api')) {
          return { ok: true, json: async () => ({ results: [] }) };
        }
        return {
          ok: true,
          json: async () => ({
            current: { temperature_2m: 22.0, weather_code: 1 },
          }),
        };
      });

      const weather = await getWeather({ city: 'NonexistentPlace' }, mockFetch as any);
      expect(weather).not.toBeNull();
      expect(weather!.temp).toBe(22.0);

      // Should have used default lat/lon (New York)
      const weatherUrl = calledUrls.find(u => u.includes('api.open-meteo.com/v1/forecast'));
      expect(weatherUrl).toContain('latitude=40.7128');
    });

    it('prefers explicit lat/lon over city name', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        return {
          ok: true,
          json: async () => ({
            current: { temperature_2m: 20.0, weather_code: 3 },
          }),
        };
      });

      // Providing both lat/lon AND city — lat/lon should take precedence
      const weather = await getWeather({ lat: 1.0, lon: 2.0, city: 'Tokyo' }, mockFetch as any);
      expect(weather).not.toBeNull();

      // Geocoding API should NOT have been called
      const geocodeCall = calledUrls.find(u => u.includes('geocoding-api'));
      expect(geocodeCall).toBeUndefined();

      // Weather should use the explicit coordinates
      const weatherUrl = calledUrls.find(u => u.includes('api.open-meteo.com/v1/forecast'));
      expect(weatherUrl).toContain('latitude=1');
      expect(weatherUrl).toContain('longitude=2');
    });
  });

  // ── Original getWeather tests (with lat/lon) ───────────────────────────────

  describe('getWeather API & Normalization', () => {
    it('fetches and normalizes current weather data', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          current: {
            temperature_2m: 22.4,
            weather_code: 0,
          },
        }),
      });

      const weather = await getWeather({ lat: 40.71, lon: -74.01 }, mockFetch as any);

      expect(weather).not.toBeNull();
      expect(weather?.temp).toBe(22.4);
      expect(weather?.condition).toBe('Clear');
      expect(weather?.code).toBe(0);
      expect(weather?.updatedAt).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('caches response for 10 minutes and does not re-fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          current: {
            temperature_2m: 18.5,
            weather_code: 3,
          },
        }),
      });

      // First call -> network fetch
      const weather1 = await getWeather({}, mockFetch as any);
      expect(weather1?.temp).toBe(18.5);
      expect(weather1?.condition).toBe('Overcast');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call within TTL -> returns cached data, mockFetch not called again
      const weather2 = await getWeather({}, mockFetch as any);
      expect(weather2?.temp).toBe(18.5);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(getWeatherCacheState().cached).toBe(true);
    });

    it('bypasses cache when forceRefresh is true', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          current: {
            temperature_2m: 20.0,
            weather_code: 1,
          },
        }),
      });

      await getWeather({}, mockFetch as any);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await getWeather({ forceRefresh: true }, mockFetch as any);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error handling & Fallbacks (§6)', () => {
    it('returns null and does not throw on network failure (fetch rejection)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error / DNS failure'));

      const weather = await getWeather({}, mockFetch as any);

      expect(weather).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns null and does not throw on HTTP status error (e.g. 500)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const weather = await getWeather({}, mockFetch as any);

      expect(weather).toBeNull();
    });

    it('returns null and does not throw on malformed JSON payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ invalid_payload: {} }),
      });

      const weather = await getWeather({}, mockFetch as any);

      expect(weather).toBeNull();
    });

    it('returns stale cache if network fails while cache exists', async () => {
      const mockFetchSuccess = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          current: {
            temperature_2m: 15.0,
            weather_code: 61,
          },
        }),
      });

      // Populate cache
      await getWeather({}, mockFetchSuccess as any);

      // Subsequent forceRefresh fails
      const mockFetchFail = vi.fn().mockRejectedValue(new Error('Connection dropped'));
      const weather = await getWeather({ forceRefresh: true }, mockFetchFail as any);

      // Should return stale cache instead of null or throwing
      expect(weather?.temp).toBe(15.0);
      expect(weather?.condition).toBe('Rain');
    });
  });
});
