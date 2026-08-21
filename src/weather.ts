/**
 * Module D — Weather Integration (Open-Meteo)
 *
 * Exposes a single normalized `getWeather()` function that retrieves current
 * weather from Open-Meteo's free, no-auth API.
 *
 * Requirements (§6):
 * - Normalized output: { temp, condition }
 * - Respects rate limits via 10-minute in-memory caching
 * - Error handling: API / network failure returns null (never throws uncaught)
 * - Standalone CLI testable
 *
 * Geocoding: when given a city name instead of lat/lon, uses Open-Meteo's free
 * geocoding API (https://geocoding-api.open-meteo.com/v1/search) to resolve
 * coordinates before fetching weather.
 */

export interface WeatherData {
  temp: number;       // Temperature in Celsius (rounded to 1 decimal)
  condition: string;  // Normalized weather description (e.g. "Clear", "Rain")
  code: number;       // Raw WMO weather code
  updatedAt: string;  // ISO timestamp of fetch time
}

export interface GeocodedLocation {
  lat: number;
  lon: number;
  name: string;       // resolved city name
  country: string;    // country code
}

export interface WeatherOptions {
  lat?: number;          // Latitude (default: 40.7128)
  lon?: number;          // Longitude (default: -74.0060)
  city?: string;         // City name — geocoded to lat/lon if lat/lon not provided
  ttlMs?: number;        // Cache TTL in ms (default: 10 min = 600,000 ms)
  forceRefresh?: boolean;// Bypass cache if true
  timeoutMs?: number;    // Fetch timeout in ms (default: 5000 ms)
}

interface CacheEntry {
  data: WeatherData;
  fetchedAt: number;
}

const DEFAULT_LAT = 40.7128;   // New York, NY
const DEFAULT_LON = -74.0060;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TIMEOUT_MS = 5000;       // 5 seconds

let cache: CacheEntry | null = null;

// Geocoding results are cached for the session — city names don't move.
const geocodeCache = new Map<string, GeocodedLocation>();

/**
 * Maps WMO Weather Interpretation Codes (WMO Code 4677) to clean conditions.
 */
export function wmoToCondition(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1 || code === 2) return 'Partly Cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if ((code >= 71 && code <= 75) || code === 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain Showers';
  if (code === 85 || code === 86) return 'Snow Showers';
  if (code >= 95 && code <= 99) return 'Thunderstorm';
  return 'Unknown';
}

/**
 * Geocode a city name to lat/lon using Open-Meteo's free geocoding API.
 *
 * Returns the top match, or null if no match found.
 * Results are cached in-memory for the session (city names don't change).
 * Never throws — returns null on any error (§6 pattern).
 */
export async function geocodeCity(
  city: string,
  customFetch: typeof fetch = typeof window !== 'undefined' ? window.fetch.bind(window) : fetch,
): Promise<GeocodedLocation | null> {
  const key = city.trim().toLowerCase();
  if (!key) return null;

  // Check in-memory cache
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.trim())}&count=1&language=en&format=json`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const response = await customFetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`[Flora/weather] Geocoding API returned HTTP ${response.status} for "${city}"`);
      return null;
    }

    const json = await response.json();
    const results = json?.results;

    if (!Array.isArray(results) || results.length === 0) {
      console.warn(`[Flora/weather] No geocoding results for "${city}"`);
      return null;
    }

    const top = results[0];
    if (typeof top.latitude !== 'number' || typeof top.longitude !== 'number') {
      console.warn(`[Flora/weather] Malformed geocoding result for "${city}":`, top);
      return null;
    }

    const location: GeocodedLocation = {
      lat: top.latitude,
      lon: top.longitude,
      name: top.name ?? city,
      country: top.country_code ?? '',
    };

    geocodeCache.set(key, location);
    console.log(`[Flora/weather] Geocoded "${city}" → ${location.lat},${location.lon} (${location.name}, ${location.country})`);
    return location;
  } catch (err: any) {
    console.warn(`[Flora/weather] Geocoding failed for "${city}": ${err?.message || err}`);
    return null;
  }
}

/**
 * Single normalized function to fetch current weather.
 *
 * Accepts lat/lon directly, OR a city name (which is geocoded automatically).
 * Returns `WeatherData` on success or `null` on network/API failure.
 * Never throws uncaught exceptions (§6 error handling requirement).
 */
export async function getWeather(
  options: WeatherOptions = {},
  customFetch: typeof fetch = typeof window !== 'undefined' ? window.fetch.bind(window) : fetch,
): Promise<WeatherData | null> {
  let lat = options.lat;
  let lon = options.lon;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const forceRefresh = options.forceRefresh ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // If no explicit lat/lon but a city name was given, geocode it
  if (lat === undefined && lon === undefined && options.city) {
    const geo = await geocodeCity(options.city, customFetch);
    if (geo) {
      lat = geo.lat;
      lon = geo.lon;
    } else {
      console.warn(`[Flora/weather] Could not geocode "${options.city}" — falling back to default location`);
      // Fall through to defaults below
    }
  }

  lat = lat ?? DEFAULT_LAT;
  lon = lon ?? DEFAULT_LON;

  const now = Date.now();

  // Return cached result if valid and not forcing refresh
  if (!forceRefresh && cache && (now - cache.fetchedAt) < ttlMs) {
    return cache.data;
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await customFetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`[Flora/weather] Open-Meteo returned HTTP status ${response.status}`);
      return cache ? cache.data : null; // Fallback to stale cache if available, else null
    }

    const json = await response.json();
    const current = json?.current;

    if (current && typeof current.temperature_2m === 'number' && typeof current.weather_code === 'number') {
      const weatherData: WeatherData = {
        temp: Math.round(current.temperature_2m * 10) / 10,
        condition: wmoToCondition(current.weather_code),
        code: current.weather_code,
        updatedAt: new Date(now).toISOString(),
      };

      cache = {
        data: weatherData,
        fetchedAt: now,
      };

      return weatherData;
    }

    console.warn('[Flora/weather] Invalid or malformed JSON structure from Open-Meteo:', json);
    return cache ? cache.data : null;
  } catch (err: any) {
    console.warn(`[Flora/weather] Network or fetch error: ${err?.message || err}`);
    // Degrade gracefully per §6: return null or stale cache, never throw uncaught
    return cache ? cache.data : null;
  }
}

/** Clear in-memory weather cache (useful for testing). */
export function clearWeatherCache(): void {
  cache = null;
}

/** Clear the geocoding cache (useful for testing). */
export function clearGeocodeCache(): void {
  geocodeCache.clear();
}

/** Diagnostic helper to inspect cache status. */
export function getWeatherCacheState(): { cached: boolean; ageMs?: number } {
  if (!cache) return { cached: false };
  return {
    cached: true,
    ageMs: Date.now() - cache.fetchedAt,
  };
}
