/**
 * Module E — LLM Reasoning Layer (Ollama backend)
 *
 * Switched to local Ollama server on 2026-08-20. All inference runs on-device
 * via http://localhost:11434 — no cloud API, no API key, no privacy trade-off.
 *
 * All public function signatures are unchanged from prior versions:
 * versions: generateMorningBrief, generateProactiveMessage, chat.
 *
 * §7 Error handling:
 *   - Proactive messages:  any failure → silent null (never surfaces to user)
 *   - Morning brief:       any failure → null (caller degrades gracefully)
 *   - Direct chat:         any failure → null (caller shows retry UI)
 *   - Ollama not running:  clear message "Local AI not running — start Ollama
 *                          and try again" (not a generic error)
 *
 * §11 Data minimization (unchanged):
 *   - Window activity arrives as category labels only (never raw titles)
 *   - Tool dispatcher validates results before sending to the LLM (see tools.ts)
 */

import {
  FLORA_SYSTEM_PROMPT,
  MAX_PROACTIVE_SENTENCES,
  type ProactiveTrigger,
  PROACTIVE_TRIGGER_LABELS,
} from './character-sheet.js';
import {
  FLORA_TOOLS,
  TOOL_NAMES,
  type ToolDispatcher,
  serializeToolResult,
} from './tools.js';

// ── Constants (single source of truth for model name) ─────────────────────────

/** The Ollama model to use. Change this one line to switch models. */
export const OLLAMA_MODEL = 'llama3.2';

/** Base URL for the local Ollama server. */
export const OLLAMA_BASE_URL = 'http://localhost:11434';

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

// ── Ollama message types ──────────────────────────────────────────────────────

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatResult {
  message: OllamaMessage;
}

// ── Ollama client interface (injectable for tests) ────────────────────────────

export interface OllamaClientInterface {
  chat(params: {
    model: string;
    messages: OllamaMessage[];
    tools?: typeof FLORA_TOOLS;
    stream: false;
  }): Promise<OllamaChatResult>;
}

export interface ReasoningConfig {
  ollamaUrl?: string;          // default: http://localhost:11434
  model?: string;              // default: OLLAMA_MODEL ('llama3.2')
  timeoutMs?: number;          // default: 30000ms (local models can be slower)
  maxToolDepth?: number;       // default: 3 (prevents infinite loops)
  toolDispatcher?: ToolDispatcher;  // injectable for tests
  _customClient?: OllamaClientInterface;  // injectable for tests
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

// ── Real Ollama client wrapper ────────────────────────────────────────────────
//
// Calls POST /api/chat on the local Ollama server.
// Response shape: { message: { role, content, tool_calls? } }

function wrapOllamaClient(baseUrl: string, timeoutMs: number): OllamaClientInterface {
  return {
    async chat(params) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Ollama returned HTTP ${res.status}: ${text}`);
        }

        const data = await res.json();
        return data as OllamaChatResult;
      } catch (err: any) {
        // Detect connection refused → Ollama not running
        if (
          err?.cause?.code === 'ECONNREFUSED' ||
          err?.message?.includes('ECONNREFUSED') ||
          err?.message?.includes('fetch failed') ||
          err?.message?.includes('Failed to fetch')
        ) {
          console.error(
            '[Flora/llm] Local AI not running — start Ollama and try again. ' +
            `Expected server at ${baseUrl}`
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ── Tool use loop (Ollama) ────────────────────────────────────────────────────
//
// Ollama tool-calling conversation format (OpenAI-compatible):
//   Message 1 (system):    { role: 'system', content: '...' }
//   Message 2 (user):      { role: 'user', content: '...' }
//   Message 3 (assistant): { role: 'assistant', tool_calls: [{ function: { name, arguments } }] }
//   Message 4 (tool):      { role: 'tool', content: '{"result": ...}' }
//   Message 5 (assistant): { role: 'assistant', content: '...' }  ← final answer

async function runToolLoop(
  client: OllamaClientInterface,
  model: string,
  systemPrompt: string,
  initialMessages: OllamaMessage[],
  dispatcher: ToolDispatcher,
  maxDepth: number,
): Promise<string | null> {
  let depth = 0;
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    ...initialMessages,
  ];

  while (depth < maxDepth) {
    const response = await client.chat({
      model,
      messages,
      tools: FLORA_TOOLS,
      stream: false,
    });

    const toolCalls = response.message.tool_calls;

    // No tool calls → we have a final text response
    if (!toolCalls || toolCalls.length === 0) {
      return response.message.content || null;
    }

    // Append the assistant's tool-call message to history
    messages.push(response.message);

    // Resolve each tool call and append tool-result messages
    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      const toolArgs = tc.function.arguments ?? {};

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

      messages.push({
        role: 'tool',
        content: JSON.stringify(serializeToolResult(toolName, toolResult)),
      });
    }

    depth++;
  }

  console.warn(`[Flora/llm] Tool call depth limit (${maxDepth}) reached — aborting`);
  return null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createReasoningEngine(config: ReasoningConfig = {}): ReasoningEngine {
  const model = config.model ?? OLLAMA_MODEL;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxToolDepth = config.maxToolDepth ?? 3;
  const baseUrl = config.ollamaUrl ?? OLLAMA_BASE_URL;

  const client: OllamaClientInterface =
    config._customClient ?? wrapOllamaClient(baseUrl, timeoutMs);

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

    const messages: OllamaMessage[] = [{ role: 'user', content: userText }];

    try {
      return await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        messages, dispatcher, maxToolDepth,
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

    const messages: OllamaMessage[] = [{ role: 'user', content: userText }];

    try {
      const raw = await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        messages, dispatcher, maxToolDepth,
      );

      if (!raw) return null;

      // §7 enforcement: trim to MAX_PROACTIVE_SENTENCES regardless of what the model returned
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

  async function chat(chatMessages: ChatMessage[]): Promise<string | null> {
    // Map ChatMessage[] → OllamaMessage[]
    const messages: OllamaMessage[] = chatMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: m.content,
    }));

    try {
      return await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        messages, dispatcher, maxToolDepth,
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
