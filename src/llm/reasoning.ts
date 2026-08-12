/**
 * Module E — LLM Reasoning Layer
 *
 * Claude API only (§10 decision). No provider abstraction.
 * Exposes three functions:
 *
 *   generateMorningBrief(signals)  → string | null
 *   generateProactiveMessage(trigger, signals) → string | null
 *   chat(messages)  → string | null
 *
 * §7 Error handling:
 *   - Proactive messages:  any failure → silent null (never surfaces to user)
 *   - Morning brief:       any failure → null (caller degrades gracefully)
 *   - Direct chat:         any failure → null (caller shows retry UI)
 *
 * §11 Data minimization:
 *   - Window activity arrives as category labels only (never raw titles)
 *   - Tool dispatcher validates results before sending to Claude (see tools.ts)
 *   - API key is never hardcoded — always injected via config
 */

import Anthropic from '@anthropic-ai/sdk';
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

export interface ReasoningConfig {
  apiKey: string;              // from OS keychain or env — never hardcoded
  model?: string;              // default: claude-opus-4-5
  timeoutMs?: number;          // default: 15000ms
  maxToolDepth?: number;       // default: 3 (prevents infinite loops)
  toolDispatcher?: ToolDispatcher;  // injectable for tests
  _customClient?: Anthropic;   // injectable for tests
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

  // Find the end index of the Nth sentence
  let endIdx = 0;
  for (let i = 0; i < max; i++) {
    if (matches[i]) {
      endIdx = (matches[i].index ?? 0) + matches[i][0].length;
    }
  }
  return trimmed.slice(0, endIdx).trim();
}

// ── Tool use loop ─────────────────────────────────────────────────────────────

async function runToolLoop(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  dispatcher: ToolDispatcher,
  maxDepth: number,
  timeoutMs: number,
): Promise<string | null> {
  let depth = 0;
  let currentMessages = [...messages];

  while (depth < maxDepth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model,
          max_tokens: 1024,
          system: systemPrompt,
          tools,
          messages: currentMessages,
        },
        { signal: controller.signal as any },
      );
    } finally {
      clearTimeout(timer);
    }

    // Extract text from stop_reason = 'end_turn'
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock && textBlock.type === 'text' ? textBlock.text : null;
    }

    // Handle tool_use
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) {
        const textBlock = response.content.find(b => b.type === 'text');
        return textBlock && textBlock.type === 'text' ? textBlock.text : null;
      }

      // Add assistant message with tool_use blocks
      currentMessages.push({ role: 'assistant', content: response.content });

      // Resolve each tool call
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        if (block.type !== 'tool_use') continue;

        const toolName = block.name;
        const toolInput = block.input as Record<string, unknown>;

        let toolContent: string;
        if (TOOL_NAMES.has(toolName)) {
          try {
            const result = await dispatcher(toolName, toolInput);
            toolContent = serializeToolResult(toolName, result);
          } catch (err: any) {
            console.warn(`[Flora/llm] Tool "${toolName}" threw: ${err?.message}`);
            toolContent = serializeToolResult(toolName, null);
          }
        } else {
          console.warn(`[Flora/llm] Unrecognized tool call: "${toolName}"`);
          toolContent = serializeToolResult(toolName, null);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolContent,
        });
      }

      // Add tool results as a user message
      currentMessages.push({ role: 'user', content: toolResults });
      depth++;
      continue;
    }

    // Unexpected stop reason
    console.warn(`[Flora/llm] Unexpected stop_reason: ${response.stop_reason}`);
    return null;
  }

  console.warn(`[Flora/llm] Tool call depth limit (${maxDepth}) reached — aborting`);
  return null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createReasoningEngine(config: ReasoningConfig): ReasoningEngine {
  const model = config.model ?? 'claude-opus-4-5';
  const timeoutMs = config.timeoutMs ?? 15_000;
  const maxToolDepth = config.maxToolDepth ?? 3;

  const client: Anthropic = config._customClient ?? new Anthropic({ apiKey: config.apiKey });

  // Default dispatcher is a no-op that returns null for every tool.
  // In production, createDefaultDispatcher() from tools.ts is passed in.
  // In tests, a mock dispatcher is injected.
  const dispatcher: ToolDispatcher = config.toolDispatcher ?? (async () => null);

  // ── generateMorningBrief ──────────────────────────────────────────────────

  async function generateMorningBrief(signals: SignalContext = {}): Promise<string | null> {
    const signalDescription = formatSignalContext(signals);
    const userMessage =
      `Please give me my morning brief. ` +
      `Use your tools to fetch current weather, calendar events, recent file activity, ` +
      `and now-playing status. ` +
      (signalDescription ? `Context: ${signalDescription}. ` : '') +
      `Keep it under 120 words, plain prose, no bullet points.`;

    try {
      return await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        [{ role: 'user', content: userMessage }],
        FLORA_TOOLS, dispatcher, maxToolDepth, timeoutMs,
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

    const userMessage =
      `Trigger: ${triggerLabel}. ` +
      (signalDescription ? `Context: ${signalDescription}. ` : '') +
      `Write a proactive message for this situation. ` +
      `Maximum 2 sentences. No opener like "Hey" or "Just so you know". ` +
      `No follow-up questions. End with a period.`;

    try {
      const raw = await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        [{ role: 'user', content: userMessage }],
        FLORA_TOOLS, dispatcher, maxToolDepth, timeoutMs,
      );

      if (!raw) return null;

      // §7 enforcement: trim to MAX_PROACTIVE_SENTENCES regardless of what Claude returned
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
    const apiMessages: Anthropic.MessageParam[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    try {
      return await runToolLoop(
        client, model, FLORA_SYSTEM_PROMPT,
        apiMessages, FLORA_TOOLS, dispatcher, maxToolDepth, timeoutMs,
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
