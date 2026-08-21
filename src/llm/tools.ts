/**
 * Module E — LLM Tool Schemas (Ollama / OpenAI-compatible format)
 *
 * Defines the four function-calling schemas passed to the local Ollama server,
 * plus the dispatcher that resolves tool calls to real Module D integrations.
 *
 * §7 requirement: "define the function-calling schema for each integration
 * up front so the LLM layer is just orchestration, not custom parsing per feature."
 *
 * §11 boundary: the dispatcher validates tool results before returning them
 * to the LLM. Any result containing raw sensitive strings (window titles, file
 * contents, OAuth tokens) is replaced with null/[] and a warning is logged.
 * The LLM payload never receives raw sensitive data.
 *
 * Switched to local Ollama on 2026-08-20. All data stays on-device — no
 * cloud API, no privacy trade-off.
 */

import type { WeatherData } from '../weather.js';
import type { CalendarEvent } from '../calendar.js';
import type { FileActivity } from '../files.js';
import type { SpotifyTrack } from '../spotify.js';

// ── Tool result types ─────────────────────────────────────────────────────────

export interface ToolResults {
  weather: WeatherData | null;
  calendar: CalendarEvent[];
  files: FileActivity[];
  nowPlaying: SpotifyTrack | null;
}

// ── Dispatcher interface (injectable for tests) ───────────────────────────────

export type ToolDispatcher = (
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

// ── §11 result validator ──────────────────────────────────────────────────────
//
// Checks that no tool result contains fields that violate the data-minimization
// rules. If a violation is detected, the result is replaced with null/[] so
// the offending data never reaches the LLM payload.
// This logic is unchanged from earlier versions — it is API-agnostic.

const FORBIDDEN_RESULT_FIELDS = ['rawTitle', 'contents', 'content', 'token', 'accessToken', 'refreshToken'];

export function validateToolResult(name: string, result: unknown): unknown {
  if (result === null || result === undefined) return result;

  const checkObject = (obj: Record<string, unknown>): boolean => {
    for (const field of FORBIDDEN_RESULT_FIELDS) {
      if (field in obj && typeof obj[field] === 'string' && (obj[field] as string).length > 0) {
        console.warn(
          `[Flora/llm] §11 VIOLATION — tool "${name}" result contains forbidden field "${field}". ` +
          `Stripping result before sending to LLM.`
        );
        return true; // violation found
      }
    }
    return false;
  };

  if (Array.isArray(result)) {
    // Filter out any array elements that contain forbidden fields
    return (result as Record<string, unknown>[]).filter(item => {
      if (typeof item === 'object' && item !== null) {
        return !checkObject(item as Record<string, unknown>);
      }
      return true;
    });
  }

  if (typeof result === 'object' && result !== null) {
    if (checkObject(result as Record<string, unknown>)) return null;
  }

  return result;
}

// ── OpenAI-compatible tool definitions (§7) ───────────────────────────────────
//
// Ollama uses the OpenAI-compatible tools format:
//   { type: 'function', function: { name, description, parameters } }
// The `parameters` field follows standard JSON Schema.

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
}

/** The tool list passed to Ollama's /api/chat `tools` field */
export const FLORA_TOOLS: OllamaToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description:
        "Get the current weather for the user's saved location. " +
        'Returns temperature and a plain-English condition string, or null if unavailable.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'Optional location override (city name or "lat,lon"). Uses saved location if omitted.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_events',
      description:
        "Get today's calendar events for the user. " +
        'Returns an array of events with title, start time, end time, and optional location. ' +
        'Returns an empty array if there are no events or the calendar is unreachable.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'ISO 8601 date string (e.g. "2026-08-12"). Defaults to today if omitted.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_notes_activity',
      description:
        "Get recently modified files from the user's watched folder. " +
        'Returns metadata only (filename, type category, modified time) — never file contents. ' +
        'Returns an empty array if no recent activity or the folder is inaccessible.',
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'Absolute path to the folder to scan. Uses the configured default if omitted.',
          },
          lookback_minutes: {
            type: 'number',
            description: 'How many minutes back to look for modifications. Default: 15.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_now_playing',
      description:
        "Get the user's current Spotify playback state. " +
        'Returns track title, artist, album, and whether it is playing or paused. ' +
        'Returns null if nothing is playing, Spotify is not connected, or the API is unreachable.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

// ── Tool names as a typed union ───────────────────────────────────────────────

export type ToolName = 'get_weather' | 'get_calendar_events' | 'get_notes_activity' | 'get_now_playing';

export const TOOL_NAMES = new Set<string>(['get_weather', 'get_calendar_events', 'get_notes_activity', 'get_now_playing']);

// ── Default dispatcher (calls real Module D integrations) ─────────────────────

export function createDefaultDispatcher(integrations: {
  getWeather?: () => Promise<WeatherData | null>;
  getTodayEvents?: () => Promise<CalendarEvent[]>;
  getRecentFiles?: (opts?: { lookbackMs?: number; folder?: string }) => Promise<FileActivity[]>;
  getNowPlaying?: () => Promise<SpotifyTrack | null>;
}): ToolDispatcher {
  return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    let result: unknown;

    switch (name as ToolName) {
      case 'get_weather':
        result = integrations.getWeather ? await integrations.getWeather() : null;
        break;

      case 'get_calendar_events':
        result = integrations.getTodayEvents ? await integrations.getTodayEvents() : [];
        break;

      case 'get_notes_activity': {
        const lookbackMin = typeof input.lookback_minutes === 'number' ? input.lookback_minutes : 15;
        const folder = typeof input.folder === 'string' ? input.folder : undefined;
        result = integrations.getRecentFiles
          ? await integrations.getRecentFiles({ lookbackMs: lookbackMin * 60_000, folder })
          : [];
        break;
      }

      case 'get_now_playing':
        result = integrations.getNowPlaying ? await integrations.getNowPlaying() : null;
        break;

      default:
        console.warn(`[Flora/llm] Unknown tool called: "${name}"`);
        result = null;
    }

    // §11: validate before returning — strip any forbidden fields
    return validateToolResult(name, result);
  };
}

// ── Serialize tool result for Ollama's tool response message ──────────────────
//
// Ollama expects the tool role message content to be a JSON string.
// We wrap the result in { result: ... } so nulls and arrays are valid objects.

export function serializeToolResult(name: string, result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) {
    return { result: null, note: `${name} returned no data — tool unavailable or no content` };
  }
  if (Array.isArray(result) && result.length === 0) {
    return { result: [], note: `${name} returned no items` };
  }
  return { result };
}

// ── Legacy string serializer (kept for test compatibility) ────────────────────
// Used by reasoning.test.ts to inspect tool result content as a string.

export function serializeToolResultString(name: string, result: unknown): string {
  const obj = serializeToolResult(name, result);
  return JSON.stringify(obj);
}
