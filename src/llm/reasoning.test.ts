import { describe, it, expect, vi, beforeEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  createReasoningEngine,
  countSentences,
  trimToSentences,
  type ChatMessage,
  type SignalContext,
} from './reasoning.js';
import { validateToolResult, serializeToolResult } from './tools.js';

// ── Anthropic mock helpers ────────────────────────────────────────────────────

/** Build a fake Claude text-only response */
function makeTextResponse(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-opus-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/** Build a fake Claude tool_use response */
function makeToolUseResponse(toolName: string, toolId: string, input: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_test_tool',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
    model: 'claude-opus-4-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 15, output_tokens: 25 },
  };
}

/** Create a mock Anthropic client */
function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callCount = 0;
  return {
    messages: {
      create: vi.fn().mockImplementation(async () => {
        const res = responses[callCount] ?? responses[responses.length - 1];
        callCount++;
        return res;
      }),
    },
  } as unknown as Anthropic;
}

/** Create a simple mock tool dispatcher */
function makeDispatcher(results: Record<string, unknown> = {}) {
  return vi.fn().mockImplementation(async (name: string) => results[name] ?? null);
}

// ── countSentences / trimToSentences ─────────────────────────────────────────

describe('Sentence utilities', () => {
  describe('countSentences', () => {
    it('counts a single sentence', () => {
      expect(countSentences('You have a meeting at 3pm.')).toBe(1);
    });

    it('counts two sentences', () => {
      expect(countSentences('Focus break detected. Your 3pm call starts in 15 minutes.')).toBe(2);
    });

    it('counts sentences ending with ! and ?', () => {
      expect(countSentences('Nice work! Ready for a break?')).toBe(2);
    });

    it('returns 0 for empty string', () => {
      expect(countSentences('')).toBe(0);
      expect(countSentences('   ')).toBe(0);
    });

    it('handles sentences with no terminal punctuation as 1', () => {
      expect(countSentences('No period here')).toBe(1);
    });
  });

  describe('trimToSentences', () => {
    it('returns text unchanged when within limit', () => {
      const text = 'One sentence.';
      expect(trimToSentences(text, 2)).toBe(text);
    });

    it('trims to exactly 2 sentences', () => {
      const text = 'Sentence one. Sentence two. Sentence three should be cut.';
      const result = trimToSentences(text, 2);
      expect(countSentences(result)).toBe(2);
      expect(result).not.toContain('Sentence three');
    });

    it('handles text already at the limit', () => {
      const text = 'First sentence. Second sentence.';
      expect(trimToSentences(text, 2)).toBe(text);
    });
  });
});

// ── validateToolResult (§11) ──────────────────────────────────────────────────

describe('§11 tool result validator', () => {
  it('passes clean tool results unchanged', () => {
    const result = { temp: 22, condition: 'Sunny' };
    expect(validateToolResult('get_weather', result)).toEqual(result);
  });

  it('strips objects containing "accessToken" (OAuth leak)', () => {
    const leak = { accessToken: 'secret-token-xyz', temp: 22 };
    const out = validateToolResult('get_weather', leak);
    expect(out).toBeNull();
  });

  it('strips objects containing "rawTitle" (window title leak)', () => {
    const leak = { rawTitle: 'Email - inbox - Outlook', category: 'communication' };
    const out = validateToolResult('get_calendar_events', leak);
    expect(out).toBeNull();
  });

  it('strips objects containing "contents" (file content leak)', () => {
    const leak = { name: 'notes.md', contents: 'My secret notes' };
    const out = validateToolResult('get_notes_activity', leak);
    expect(out).toBeNull();
  });

  it('filters violating elements from arrays while keeping clean ones', () => {
    const arr = [
      { name: 'file.md', type: 'document', modifiedAt: '2026-08-12T09:00:00Z' },  // clean
      { name: 'leak.md', type: 'document', content: 'raw content here' },          // has 'content'
    ];
    const out = validateToolResult('get_notes_activity', arr) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('file.md');
  });

  it('passes null and empty array unchanged', () => {
    expect(validateToolResult('get_weather', null)).toBeNull();
    expect(validateToolResult('get_calendar_events', [])).toEqual([]);
  });
});

// ── serializeToolResult ───────────────────────────────────────────────────────

describe('serializeToolResult', () => {
  it('serializes a non-null result to JSON', () => {
    const result = { temp: 22, condition: 'Sunny' };
    expect(serializeToolResult('get_weather', result)).toContain('"temp":22');
  });

  it('returns a descriptive string for null', () => {
    const out = serializeToolResult('get_weather', null);
    expect(out).toContain('null');
    expect(out).toContain('get_weather');
  });

  it('returns a descriptive string for empty array', () => {
    const out = serializeToolResult('get_calendar_events', []);
    expect(out).toContain('[]');
    expect(out).toContain('get_calendar_events');
  });
});

// ── generateMorningBrief ──────────────────────────────────────────────────────

describe('Module E — generateMorningBrief', () => {
  it('returns a string when Claude responds with text', async () => {
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([makeTextResponse('It\'s 22°C and partly cloudy. Nothing on your calendar today.')]),
      toolDispatcher: makeDispatcher(),
    });

    const brief = await engine.generateMorningBrief();
    expect(typeof brief).toBe('string');
    expect(brief).not.toBeNull();
  });

  it('uses tool results when Claude calls get_weather then responds', async () => {
    const dispatcher = makeDispatcher({ get_weather: { temp: 18, condition: 'Cloudy' } });
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([
        makeToolUseResponse('get_weather', 'tool_1'),
        makeTextResponse('It\'s 18°C and cloudy. No meetings today.'),
      ]),
      toolDispatcher: dispatcher,
    });

    const brief = await engine.generateMorningBrief();
    expect(brief).toContain('cloudy');
    expect(dispatcher).toHaveBeenCalledWith('get_weather', expect.any(Object));
  });

  it('returns null on API failure (§7 — graceful degradation)', async () => {
    const failClient = {
      messages: { create: vi.fn().mockRejectedValue(new Error('Network timeout')) },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({ apiKey: 'test', _customClient: failClient, toolDispatcher: makeDispatcher() });
    const brief = await engine.generateMorningBrief();
    expect(brief).toBeNull();
  });

  it('returns null on API timeout (aborted request)', async () => {
    const timeoutClient = {
      messages: {
        create: vi.fn().mockImplementation(() => {
          const err = new Error('Request aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }),
      },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: timeoutClient,
      toolDispatcher: makeDispatcher(),
      timeoutMs: 1,
    });
    const brief = await engine.generateMorningBrief();
    expect(brief).toBeNull();
  });

  it('handles all-missing data gracefully (all tools return null/[])', async () => {
    const emptyDispatcher = makeDispatcher({
      get_weather: null,
      get_calendar_events: [],
      get_notes_activity: [],
      get_now_playing: null,
    });

    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([makeTextResponse("Couldn't reach weather or calendar today. No recent file activity.")]),
      toolDispatcher: emptyDispatcher,
    });

    const brief = await engine.generateMorningBrief();
    expect(brief).not.toBeNull();
    expect(brief).not.toContain('sunny');  // no hallucination
  });

  it('passes SignalContext to the brief prompt', async () => {
    const signals: SignalContext = { timeOfDay: 'morning', windowCategory: 'code_editor' };
    let capturedMessages: any[] = [];

    const capturingClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages;
          return makeTextResponse('Morning brief text.');
        }),
      },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: capturingClient,
      toolDispatcher: makeDispatcher(),
    });

    await engine.generateMorningBrief(signals);
    const userContent = capturedMessages[0]?.content as string ?? '';
    expect(userContent).toContain('morning');
    expect(userContent).toContain('code_editor');
  });
});

// ── generateProactiveMessage ──────────────────────────────────────────────────

describe('Module E — generateProactiveMessage', () => {
  it('returns a 1-2 sentence message for a valid trigger', async () => {
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([makeTextResponse('Your 3pm call starts in 15 minutes.')]),
      toolDispatcher: makeDispatcher(),
    });

    const msg = await engine.generateProactiveMessage('focus_break');
    expect(typeof msg).toBe('string');
    expect(countSentences(msg!)).toBeLessThanOrEqual(2);
  });

  it('trims responses exceeding 2 sentences (§7 enforcement)', async () => {
    const longText = 'Sentence one. Sentence two. Sentence three is too long. Sentence four also.';
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([makeTextResponse(longText)]),
      toolDispatcher: makeDispatcher(),
    });

    const msg = await engine.generateProactiveMessage('long_idle');
    expect(msg).not.toBeNull();
    expect(countSentences(msg!)).toBeLessThanOrEqual(2);
    expect(msg).not.toContain('Sentence three');
  });

  it('returns null silently on API failure (§7 — never surfaces to user)', async () => {
    const failClient = {
      messages: { create: vi.fn().mockRejectedValue(new Error('Service unavailable')) },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({ apiKey: 'test', _customClient: failClient, toolDispatcher: makeDispatcher() });
    // Must not throw
    const msg = await engine.generateProactiveMessage('new_event');
    expect(msg).toBeNull();
  });

  it('handles all six trigger types without throwing', async () => {
    const triggers = ['focus_break', 'long_idle', 'new_event', 'now_playing', 'morning_startup', 'focus_ended'] as const;
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([makeTextResponse('One sentence.')]),
      toolDispatcher: makeDispatcher(),
    });

    for (const trigger of triggers) {
      const result = await engine.generateProactiveMessage(trigger);
      expect(typeof result === 'string' || result === null).toBe(true);
    }
  });
});

// ── chat ─────────────────────────────────────────────────────────────────────

describe('Module E — chat', () => {
  it('returns a response for a simple message', async () => {
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([makeTextResponse("You have a meeting at 3pm.")]),
      toolDispatcher: makeDispatcher(),
    });

    const messages: ChatMessage[] = [{ role: 'user', content: "What's on my calendar?" }];
    const reply = await engine.chat(messages);
    expect(reply).toBe("You have a meeting at 3pm.");
  });

  it('completes a tool-use round-trip', async () => {
    const dispatcher = makeDispatcher({
      get_calendar_events: [{ title: 'Sprint Planning', start: '2026-08-12T14:00:00Z', end: '2026-08-12T15:00:00Z', allDay: false }],
    });
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: mockClient([
        makeToolUseResponse('get_calendar_events', 'tool_call_1'),
        makeTextResponse('You have Sprint Planning at 2pm.'),
      ]),
      toolDispatcher: dispatcher,
    });

    const reply = await engine.chat([{ role: 'user', content: "What's on my calendar?" }]);
    expect(reply).toBe('You have Sprint Planning at 2pm.');
    expect(dispatcher).toHaveBeenCalledWith('get_calendar_events', expect.any(Object));
  });

  it('respects max tool depth (§7 — prevents infinite loops)', async () => {
    // Always returns tool_use, never end_turn → should hit the depth limit
    const infiniteClient = {
      messages: {
        create: vi.fn().mockResolvedValue(makeToolUseResponse('get_weather', 'tool_loop')),
      },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: infiniteClient,
      toolDispatcher: makeDispatcher({ get_weather: { temp: 20, condition: 'Clear' } }),
      maxToolDepth: 3,
    });

    const reply = await engine.chat([{ role: 'user', content: 'What is the weather?' }]);
    expect(reply).toBeNull();
    // Should have called Claude exactly maxToolDepth (3) times
    expect((infiniteClient.messages.create as any).mock.calls.length).toBe(3);
  });

  it('returns null on API failure (caller shows retry UI)', async () => {
    const failClient = {
      messages: { create: vi.fn().mockRejectedValue(new Error('Connection refused')) },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({ apiKey: 'test', _customClient: failClient, toolDispatcher: makeDispatcher() });
    const reply = await engine.chat([{ role: 'user', content: 'Hello' }]);
    expect(reply).toBeNull();
  });

  it('handles multi-turn conversation history', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Good morning' },
      { role: 'assistant', content: 'Good morning. Weather looks clear.' },
      { role: 'user', content: 'Any meetings?' },
    ];

    let capturedMessages: any[] = [];
    const capturingClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedMessages = params.messages;
          return makeTextResponse('You have a 2pm standup.');
        }),
      },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: capturingClient,
      toolDispatcher: makeDispatcher(),
    });

    await engine.chat(messages);
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[2].content).toBe('Any meetings?');
  });

  it('does not call unknown tools (unrecognized tool name returns null)', async () => {
    const weirdToolClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce(makeToolUseResponse('hack_the_planet', 'hack_1'))
          .mockResolvedValueOnce(makeTextResponse('Here is your result.')),
      },
    } as unknown as Anthropic;

    const dispatcher = makeDispatcher();
    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: weirdToolClient,
      toolDispatcher: dispatcher,
    });

    const reply = await engine.chat([{ role: 'user', content: 'Do something' }]);
    // Unknown tool dispatched as null — does not throw
    expect(reply).toBe('Here is your result.');
    expect(dispatcher).not.toHaveBeenCalled(); // dispatcher not called for unknown tools
  });
});

// ── §11 system prompt check ───────────────────────────────────────────────────

describe('§11 — system prompt data minimization', () => {
  it('system prompt contains the window-category boundary rule', async () => {
    const { FLORA_SYSTEM_PROMPT } = await import('./character-sheet.js');
    expect(FLORA_SYSTEM_PROMPT).toContain('window-activity data as category labels only');
    expect(FLORA_SYSTEM_PROMPT).toContain('never raw window titles');
  });

  it('system prompt contains the no-hallucination rule', async () => {
    const { FLORA_SYSTEM_PROMPT } = await import('./character-sheet.js');
    expect(FLORA_SYSTEM_PROMPT).toContain('never invent');
  });

  it('system prompt contains the 2-sentence proactive rule', async () => {
    const { FLORA_SYSTEM_PROMPT } = await import('./character-sheet.js');
    expect(FLORA_SYSTEM_PROMPT).toContain('Maximum 2 sentences');
  });

  it('system prompt is passed in every Claude API call', async () => {
    let capturedSystem = '';
    const capturingClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: any) => {
          capturedSystem = params.system;
          return makeTextResponse('Test response.');
        }),
      },
    } as unknown as Anthropic;

    const engine = createReasoningEngine({
      apiKey: 'test',
      _customClient: capturingClient,
      toolDispatcher: makeDispatcher(),
    });

    await engine.generateMorningBrief();
    expect(capturedSystem).toContain('FLORA — CHARACTER SHEET');
    expect(capturedSystem.length).toBeGreaterThan(500); // not a stub prompt
  });

  it('SignalContext only allows WindowCategory labels — type is a string union (compile check)', () => {
    // This test is structural — if it compiles, the type constraint is enforced.
    const signals: SignalContext = {
      windowCategory: 'code_editor',  // valid
      timeOfDay: 'morning',
    };
    // Cannot assign a raw title: signals.windowCategory = 'My - Email Subject' would be a type error
    expect(signals.windowCategory).toBe('code_editor');
  });
});
