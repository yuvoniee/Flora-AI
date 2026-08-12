/**
 * Module E — LLM Reasoning Layer (Gemini backend)
 *
 * Switched from Anthropic claude-opus-4-5 to Google Gemini gemini-2.0-flash
 * on 2026-08-12 to use the free tier. All public function signatures are
 * unchanged: generateMorningBrief, generateProactiveMessage, chat.
 *
 * ⚠️  FREE-TIER PRIVACY NOTE: Gemini API free-tier requests may be used by
 * Google to improve their models. Swap to a paid tier before handling real
 * personal data long-term (calendar events, filenames, music history). See:
 * https://ai.google.dev/gemini-api/terms
 *
 * §7 Error handling (unchanged from Anthropic version):
 *   - Proactive messages:  any failure → silent null (never surfaces to user)
 *   - Morning brief:       any failure → null (caller degrades gracefully)
 *   - Direct chat:         any failure → null (caller shows retry UI)
 *
 * §11 Data minimization (unchanged):
 *   - Window activity arrives as category labels only (never raw titles)
 *   - Tool dispatcher validates results before sending to Gemini (see tools.ts)
 *   - API key is never hardcoded — always injected via config
 */

import { GoogleGenAI } from '@google/genai';
import type {
  Content,
  Part,
  GenerateContentResponse,
} from '@google/genai';
import {
  FLORA_SYSTEM_PROMPT,
  MAX_PROACTIVE_SENTENCES,
  type ProactiveTrigger,
  PROACTIVE_TRIGGER_LABELS,
} from './character-sheet.js';
import {
  FLORA_GEMINI_TOOLS,
  TOOL_NAMES,
  type ToolDispatcher,
  serializeToolResult,
} from './tools.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Window activity signal — categories only, never raw title strings (§11) */
export type WindowCategory = 'browser' | 'code_editor' | 'document_app' | 'terminal' |
  'communication' | 'media' | 'idle' | 'other';

export interface SignalContext {
  windowCategory?: WindowCategory;   // current app category — never raw title
  idleDurationMs?: number;           // how long the user has been idle
  focusDurationMs?: number;          // how long in current focus session
  timeOfDay?: 'morning' | 'afternoon' | 'evening';
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── Gemini client interface (injectable for tests) ────────────────────────────
//
// We define a minimal interface over the parts of GoogleGenAI we actually use.
// This lets tests inject a mock without depending on the real SDK shape.

export interface GeminiGenerateResult {
  /** Returns the first text part, or null if there is none */
  text(): string | null;
  /** Returns all function call parts in this response */
  functionCalls(): Array<{ name: string; args: Record<string, unknown> }> | undefined;
}

export interface GeminiClientInterface {
  generateContent(params: {
    model: string;
    contents: Content[];
    config: {
      systemInstruction: string;
      tools: typeof FLORA_GEMINI_TOOLS;
      maxOutputTokens: number;
      abortSignal: AbortSignal;
    };
  }): Promise<GeminiGenerateResult>;
}

export interface ReasoningConfig {
  apiKey: string;              // from OS keychain or env — never hardcoded
  model?: string;              // default: gemini-2.0-flash
  timeoutMs?: number;          // default: 15000ms
  maxToolDepth?: number;       // default: 3 (prevents infinite loops)
  toolDispatcher?: ToolDispatcher;  // injectable for tests
  _customClient?: GeminiClientInterface;  // injectable for tests
}

export interface ReasoningEngine {
  generateMorningBrief(signals?: SignalContext): Promise<string | null>;
  generateProactiveMessage(trigger: ProactiveTrigger, signals?: SignalContext): Promise<string | null>;
  chat(messages: ChatMessage[]): Promise<string | null>;
}

// ── Sentence counting (proactive message enforcement) ────────────────────────

/**
 * Count sentences in a string — used to enforce the 2-sentence proactive limit.
 * Splits on . ! ? followed by whitespace or end of string.
 */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(/[^.!?]*[.!?]+(\s|$)/g);
  return matches ? matches.length : 1;
}

/**
 * Trim text to at most N sentences.
 * If the text has fewer or equal sentences, returns it unchanged.
 */
export function trimToSentences(text: string, max: number): string {
  const trimmed = text.trim();
  const sentencePattern = /[^.!?]*[.!?]+(\s|$)/g;
  const matches = [...trimmed.matchAll(sentencePattern)];
  if (matches.length <= max) return trimmed;

  let endIdx = 0;
  for (let i = 0; i < max; i++) {
    if (matches[i]) {
      endIdx = (matches[i].index ?? 0) + matches[i][0].length;
    }
  }
  return trimmed.slice(0, endIdx).trim();
}

// ── Real Gemini client wrapper ────────────────────────────────────────────────
//
// Wraps GoogleGenAI so it matches GeminiClientInterface.
// GenerateContentResponse.text() returns string | undefined in the SDK;
// we normalize to string | null here.

function wrapRealClient(apiKey: string): GeminiClientInterface {
  const sdk = new GoogleGenAI({ apiKey });

  return {
    async generateContent(params) {
      const raw: GenerateContentResponse = await sdk.models.generateContent({
        model: params.model,
        contents: params.contents,
        config: {
          systemInstruction: params.config.systemInstruction,
          tools: params.config.tools as any,
          maxOutputTokens: params.config.maxOutputTokens,
          abortSignal: params.config.abortSignal,
        },
      });

      return {
        text: () => raw.text ?? null,
        functionCalls: () => {
          // raw.functionCalls is a getter property, not a method
          const calls = raw.functionCalls;
          if (!calls || calls.length === 0) return undefined;
          return calls.map((c: { name?: string; args?: Record<string, unknown> }) => ({
            name: c.name ?? '',
            args: (c.args ?? {}) as Record<string, unknown>,
          }));
        },
      };
    },
  };
}

// ── Tool use loop (Gemini) ────────────────────────────────────────────────────
//
// Gemini function-calling conversation format:
//   Turn 1 (user):  { role: 'user', parts: [{ text: '...' }] }
//   Turn 2 (model): { role: 'model', parts: [{ functionCall: { name, args } }] }
//   Turn 3 (user):  { role: 'user', parts: [{ functionResponse: { name, response } }] }
//   Turn 4 (model): { role: 'model', parts: [{ text: '...' }] }  ← final answer

async function runToolLoop(
  client: GeminiClientInterface,
  model: string,
  systemPrompt: string,
  initialContents: Content[],
  dispatcher: ToolDispatcher,
  maxDepth: number,
  timeoutMs: number,
): Promise<string | null> {
  let depth = 0;
  const contents: Content[] = [...initialContents];

  while (depth < maxDepth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: GeminiGenerateResult;
    try {
      response = await client.generateContent({
        model,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools: FLORA_GEMINI_TOOLS,
          maxOutputTokens: 1024,
          abortSignal: controller.signal,
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const functionCalls = response.functionCalls();

    // No function calls → we have a final text response
    if (!functionCalls || functionCalls.length === 0) {
      return response.text();
    }

    // Append the model's function-call turn to history
    const modelParts: Part[] = functionCalls.map(fc => ({
      functionCall: { name: fc.name, args: fc.args },
    }));
    contents.push({ role: 'model', parts: modelParts });

    // Resolve each function call and build the user response turn
    const responseParts: Part[] = [];
    for (const fc of functionCalls) {
      const toolName = fc.name;
      const toolArgs = fc.args;

      let toolResult: unknown;
      if (TOOL_NAMES.has(toolName)) {
        try {
          toolResult = await dispatcher(toolName, toolArgs);
        } catch (err: any) {
          console.warn(`[Flora/llm] Tool "${toolName}" threw: ${err?.message}`);
          toolResult = null;
        }
      } else {
        console.warn(`[Flora/llm] Unrecognized tool call: "${toolName}"`);
        toolResult = null;
      }

      responseParts.push({
        functionResponse: {
          name: toolName,
          response: serializeToolResult(toolName, toolResult),
        },
      });
    }

    // Append the tool-result turn as 'user' (Gemini convention)
    contents.push({ role: 'user', parts: responseParts });
    depth++;
  }

  console.warn(`[Flora/llm] Tool call depth limit (${maxDepth}) reached — aborting`);
  return null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createReasoningEngine(config: ReasoningConfig): ReasoningEngine {
  const model = config.model ?? 'gemini-2.0-flash';
  const timeoutMs = config.timeoutMs ?? 15_000;
  const maxToolDepth = config.maxToolDepth ?? 3;

  const client: GeminiClientInterface =
    config._customClient ?? wrapRealClient(config.apiKey);

  // Default dispatcher returns null for every tool.
  // In production, createDefaultDispatcher() from tools.ts is passed in.
  // In tests, a mock dispatcher is injected.
  const dispatcher: ToolDispatcher = config.toolDispatcher ?? (async () => null);

  // ── generateMorningBrief ──────────────────────────────────────────────────

  async function generateMorningBrief(signals: SignalContext = {}): Promise<string | null> {
    const signalDescription = formatSignalContext(signals);
    const userText =
      `Please give me my morning brief. ` +
      `Use your tools to fetch current weather, calendar events, recent file activity, ` +
      `and now-playing status. ` +
      (signalDescription ? `Context: ${signalDescription}. ` : '') +
      `Keep it under 120 words, plain prose, no bullet points.`;

    const contents: Content[] = [{ role: 'user', parts: [{ text: userText }] }];

    try {
      return await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        contents, dispatcher, maxToolDepth, timeoutMs,
      );
    } catch (err: any) {
      console.warn(`[Flora/llm] generateMorningBrief failed: ${err?.message}`);
      return null;
    }
  }

  // ── generateProactiveMessage ──────────────────────────────────────────────

  async function generateProactiveMessage(
    trigger: ProactiveTrigger,
    signals: SignalContext = {},
  ): Promise<string | null> {
    const triggerLabel = PROACTIVE_TRIGGER_LABELS[trigger];
    const signalDescription = formatSignalContext(signals);

    const userText =
      `Trigger: ${triggerLabel}. ` +
      (signalDescription ? `Context: ${signalDescription}. ` : '') +
      `Write a proactive message for this situation. ` +
      `Maximum 2 sentences. No opener like "Hey" or "Just so you know". ` +
      `No follow-up questions. End with a period.`;

    const contents: Content[] = [{ role: 'user', parts: [{ text: userText }] }];

    try {
      const raw = await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        contents, dispatcher, maxToolDepth, timeoutMs,
      );

      if (!raw) return null;

      // §7 enforcement: trim to MAX_PROACTIVE_SENTENCES regardless of what Gemini returned
      const count = countSentences(raw);
      if (count > MAX_PROACTIVE_SENTENCES) {
        console.warn(
          `[Flora/llm] Proactive message exceeded ${MAX_PROACTIVE_SENTENCES} sentences ` +
          `(got ${count}) — trimming.`
        );
        return trimToSentences(raw, MAX_PROACTIVE_SENTENCES);
      }

      return raw;
    } catch (err: any) {
      // §7: silent failure for proactive messages — never surfaces to user
      console.warn(`[Flora/llm] generateProactiveMessage failed (silent): ${err?.message}`);
      return null;
    }
  }

  // ── chat ─────────────────────────────────────────────────────────────────

  async function chat(messages: ChatMessage[]): Promise<string | null> {
    // Map ChatMessage[] → Gemini Content[]
    // 'assistant' role maps to 'model' in Gemini's convention
    const contents: Content[] = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    try {
      return await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        contents, dispatcher, maxToolDepth, timeoutMs,
      );
    } catch (err: any) {
      console.warn(`[Flora/llm] chat failed: ${err?.message}`);
      return null;  // caller shows retry UI
    }
  }

  return { generateMorningBrief, generateProactiveMessage, chat };
}

// ── Signal context formatter ──────────────────────────────────────────────────
//
// Converts the structured SignalContext into a plain sentence for the user message.
// §11: WindowCategory labels only — never raw strings — are what arrive here.

function formatSignalContext(signals: SignalContext): string {
  const parts: string[] = [];

  if (signals.windowCategory) {
    parts.push(`current app category: ${signals.windowCategory}`);
  }
  if (signals.focusDurationMs) {
    const focusMin = Math.round(signals.focusDurationMs / 60_000);
    parts.push(`${focusMin} minutes in current focus session`);
  }
  if (signals.idleDurationMs) {
    const idleMin = Math.round(signals.idleDurationMs / 60_000);
    parts.push(`${idleMin} minutes idle`);
  }
  if (signals.timeOfDay) {
    parts.push(`time of day: ${signals.timeOfDay}`);
  }

  return parts.join(', ');
}
