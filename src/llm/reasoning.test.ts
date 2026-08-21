import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createReasoningEngine,
  countSentences,
  trimToSentences,
  type ChatMessage,
  type SignalContext,
  type OllamaClientInterface,
  type OllamaChatResult,
  type OllamaMessage,
} from './reasoning.js';
import { validateToolResult, serializeToolResult, serializeToolResultString } from './tools.js';

// ── Ollama mock helpers ───────────────────────────────────────────────────────
//
// All mocks implement OllamaClientInterface — zero dependency on any SDK.

/** Build a fake Ollama text-only result */
function makeTextResult(text: string): OllamaChatResult {
  return {
    message: { role: 'assistant', content: text },
  };
}

/** Build a fake Ollama tool-call result */
function makeFunctionCallResult(
  calls: Array<{ name: string; args?: Record<string, unknown> }>
): OllamaChatResult {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: calls.map(c => ({
        function: { name: c.name, arguments: c.args ?? {} },
      })),
    },
  };
}

/** Create a mock OllamaClientInterface */
function mockOllamaClient(results: OllamaChatResult[]): OllamaClientInterface {
  let callCount = 0;
  return {
    chat: vi.fn().mockImplementation(async () => {
      const res = results[callCount] ?? results[results.length - 1];
      callCount++;
      return res;
    }),
  };
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
  it('wraps a non-null result in { result: ... }', () => {
    const result = { temp: 22, condition: 'Sunny' };
    const out = serializeToolResult('get_weather', result);
    expect(out).toEqual({ result });
  });

  it('returns { result: null, note } for null', () => {
    const out = serializeToolResult('get_weather', null);
    expect(out.result).toBeNull();
    expect(typeof out.note).toBe('string');
    expect(out.note as string).toContain('get_weather');
  });

  it('returns { result: [], note } for empty array', () => {
    const out = serializeToolResult('get_calendar_events', []);
    expect(out.result).toEqual([]);
    expect(out.note as string).toContain('get_calendar_events');
  });

  it('serializeToolResultString produces JSON string', () => {
    const out = serializeToolResultString('get_weather', { temp: 18 });
    expect(out).toContain('"temp":18');
  });
});

// ── generateMorningBrief ──────────────────────────────────────────────────────

describe('Module E — generateMorningBrief', () => {
  it('returns a string when the model responds with text', async () => {
    const engine = createReasoningEngine({
      _customClient: mockOllamaClient([makeTextResult("It's 22°C and partly cloudy. Nothing on your calendar today.")]),
      toolDispatcher: makeDispatcher(),
    });

    const brief = await engine.generateMorningBrief();
    expect(typeof brief).toBe('string');
    expect(brief).not.toBeNull();
  });

  it('resolves a tool call and uses the result', async () => {
    const dispatcher = makeDispatcher({ get_weather: { temp: 18, condition: 'Cloudy' } });
    const engine = createReasoningEngine({
      _customClient: mockOllamaClient([
        makeFunctionCallResult([{ name: 'get_weather' }]),
        makeTextResult("It's 18°C and cloudy. No meetings today."),
      ]),
      toolDispatcher: dispatcher,
    });

    const brief = await engine.generateMorningBrief();
    expect(brief).toContain('cloudy');
    expect(dispatcher).toHaveBeenCalledWith('get_weather', expect.any(Object));
  });

  it('returns null on API failure (§7 — graceful degradation)', async () => {
    const failClient: OllamaClientInterface = {
      chat: vi.fn().mockRejectedValue(new Error('Network timeout')),
    };

    const engine = createReasoningEngine({ _customClient: failClient, toolDispatcher: makeDispatcher() });
    const brief = await engine.generateMorningBrief();
    expect(brief).toBeNull();
  });

  it('returns null on API timeout (aborted request)', async () => {
    const timeoutClient: OllamaClientInterface = {
      chat: vi.fn().mockImplementation(() => {
        const err = new Error('Request aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }),
    };

    const engine = createReasoningEngine({
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
      _customClient: mockOllamaClient([makeTextResult("Couldn't reach weather or calendar today. No recent file activity.")]),
      toolDispatcher: emptyDispatcher,
    });

    const brief = await engine.generateMorningBrief();
    expect(brief).not.toBeNull();
    expect(brief).not.toContain('sunny');  // no hallucination
  });

  it('passes SignalContext to the brief prompt', async () => {
    const signals: SignalContext = { timeOfDay: 'morning', windowCategory: 'code_editor' };
    let capturedMessages: any[] = [];

    const capturingClient: OllamaClientInterface = {
      chat: vi.fn().mockImplementation(async (params: any) => {
        capturedMessages = params.messages;
        return makeTextResult('Morning brief text.');
      }),
    };

    const engine = createReasoningEngine({
      _customClient: capturingClient,
      toolDispatcher: makeDispatcher(),
    });

    await engine.generateMorningBrief(signals);
    // messages[0] is system, messages[1] is user
    const userText = capturedMessages[1]?.content ?? '';
    expect(userText).toContain('morning');
    expect(userText).toContain('code_editor');
  });
});

// ── generateProactiveMessage ──────────────────────────────────────────────────

describe('Module E — generateProactiveMessage', () => {
  it('returns a 1-2 sentence message for a valid trigger', async () => {
    const engine = createReasoningEngine({
      _customClient: mockOllamaClient([makeTextResult('Your 3pm call starts in 15 minutes.')]),
      toolDispatcher: makeDispatcher(),
    });

    const msg = await engine.generateProactiveMessage('focus_break');
    expect(typeof msg).toBe('string');
    expect(countSentences(msg!)).toBeLessThanOrEqual(2);
  });

  it('trims responses exceeding 2 sentences (§7 enforcement)', async () => {
    const longText = 'Sentence one. Sentence two. Sentence three is too long. Sentence four also.';
    const engine = createReasoningEngine({
      _customClient: mockOllamaClient([makeTextResult(longText)]),
      toolDispatcher: makeDispatcher(),
    });

    const msg = await engine.generateProactiveMessage('long_idle');
    expect(msg).not.toBeNull();
    expect(countSentences(msg!)).toBeLessThanOrEqual(2);
    expect(msg).not.toContain('Sentence three');
  });

  it('returns null silently on API failure (§7 — never surfaces to user)', async () => {
    const failClient: OllamaClientInterface = {
      chat: vi.fn().mockRejectedValue(new Error('Service unavailable')),
    };

    const engine = createReasoningEngine({ _customClient: failClient, toolDispatcher: makeDispatcher() });
    // Must not throw
    const msg = await engine.generateProactiveMessage('new_event');
    expect(msg).toBeNull();
  });

  it('handles all six trigger types without throwing', async () => {
    const triggers = ['focus_break', 'long_idle', 'new_event', 'now_playing', 'morning_startup', 'focus_ended'] as const;
    const engine = createReasoningEngine({
      _customClient: mockOllamaClient([makeTextResult('One sentence.')]),
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
      _customClient: mockOllamaClient([makeTextResult('You have a meeting at 3pm.')]),
      toolDispatcher: makeDispatcher(),
    });

    const messages: ChatMessage[] = [{ role: 'user', content: "What's on my calendar?" }];
    const reply = await engine.chat(messages);
    expect(reply).toBe('You have a meeting at 3pm.');
  });

  it('preserves "assistant" role as-is for Ollama (no role mapping needed)', async () => {
    let capturedMessages: any[] = [];

    const capturingClient: OllamaClientInterface = {
      chat: vi.fn().mockImplementation(async (params: any) => {
        capturedMessages = params.messages;
        return makeTextResult('Reply.');
      }),
    };

    const engine = createReasoningEngine({
      _customClient: capturingClient,
      toolDispatcher: makeDispatcher(),
    });

    await engine.chat([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'Any meetings?' },
    ]);

    // messages[0] is system, [1..3] are user/assistant/user
    expect(capturedMessages[1].role).toBe('user');
    expect(capturedMessages[2].role).toBe('assistant');
    expect(capturedMessages[3].role).toBe('user');
  });

  it('completes a tool-use round-trip', async () => {
    const dispatcher = makeDispatcher({
      get_calendar_events: [{ title: 'Sprint Planning', start: '2026-08-12T14:00:00Z', end: '2026-08-12T15:00:00Z', allDay: false }],
    });
    const engine = createReasoningEngine({
      _customClient: mockOllamaClient([
        makeFunctionCallResult([{ name: 'get_calendar_events' }]),
        makeTextResult('You have Sprint Planning at 2pm.'),
      ]),
      toolDispatcher: dispatcher,
    });

    const reply = await engine.chat([{ role: 'user', content: "What's on my calendar?" }]);
    expect(reply).toBe('You have Sprint Planning at 2pm.');
    expect(dispatcher).toHaveBeenCalledWith('get_calendar_events', expect.any(Object));
  });

  it('respects max tool depth (§7 — prevents infinite loops)', async () => {
    // Always returns a function call, never text → should hit the depth limit
    const infiniteClient: OllamaClientInterface = {
      chat: vi.fn().mockResolvedValue(
        makeFunctionCallResult([{ name: 'get_weather' }])
      ),
    };

    const engine = createReasoningEngine({
      _customClient: infiniteClient,
      toolDispatcher: makeDispatcher({ get_weather: { temp: 20, condition: 'Clear' } }),
      maxToolDepth: 3,
    });

    const reply = await engine.chat([{ role: 'user', content: 'What is the weather?' }]);
    expect(reply).toBeNull();
    // Should have called Ollama exactly maxToolDepth (3) times
    expect((infiniteClient.chat as any).mock.calls.length).toBe(3);
  });

  it('returns null on API failure (caller shows retry UI)', async () => {
    const failClient: OllamaClientInterface = {
      chat: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    const engine = createReasoningEngine({ _customClient: failClient, toolDispatcher: makeDispatcher() });
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
    const capturingClient: OllamaClientInterface = {
      chat: vi.fn().mockImplementation(async (params: any) => {
        capturedMessages = params.messages;
        return makeTextResult('You have a 2pm standup.');
      }),
    };

    const engine = createReasoningEngine({
      _customClient: capturingClient,
      toolDispatcher: makeDispatcher(),
    });

    await engine.chat(messages);
    // messages[0] = system, [1..3] = user/assistant/user
    expect(capturedMessages).toHaveLength(4);
    expect(capturedMessages[3].content).toBe('Any meetings?');
  });

  it('handles unrecognized tool names gracefully (returns null for that tool)', async () => {
    const weirdClient: OllamaClientInterface = {
      chat: vi.fn()
        .mockResolvedValueOnce(makeFunctionCallResult([{ name: 'hack_the_planet' }]))
        .mockResolvedValueOnce(makeTextResult('Here is your result.')),
    };

    const dispatcher = makeDispatcher();
    const engine = createReasoningEngine({
      _customClient: weirdClient,
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

  it('system prompt is passed as a system message in every Ollama API call', async () => {
    let capturedMessages: OllamaMessage[] = [];
    const capturingClient: OllamaClientInterface = {
      chat: vi.fn().mockImplementation(async (params: any) => {
        capturedMessages = params.messages;
        return makeTextResult('Test response.');
      }),
    };

    const engine = createReasoningEngine({
      _customClient: capturingClient,
      toolDispatcher: makeDispatcher(),
    });

    await engine.generateMorningBrief();
    // First message should be the system prompt
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[0].content).toContain('FLORA — CHARACTER SHEET');
    expect(capturedMessages[0].content.length).toBeGreaterThan(500);
  });

  it('SignalContext only allows WindowCategory labels — type is a string union (compile check)', () => {
    const signals: SignalContext = {
      windowCategory: 'code_editor',
      timeOfDay: 'morning',
    };
    expect(signals.windowCategory).toBe('code_editor');
  });

  it('tool definitions use OpenAI-compatible format for Ollama', async () => {
    const { FLORA_TOOLS } = await import('./tools.js');
    expect(FLORA_TOOLS.length).toBe(4);
    expect(FLORA_TOOLS[0].type).toBe('function');
    expect(FLORA_TOOLS[0].function).toHaveProperty('name');
    expect(FLORA_TOOLS[0].function).toHaveProperty('parameters');
    const names = FLORA_TOOLS.map((t: any) => t.function.name);
    expect(names).toContain('get_weather');
    expect(names).toContain('get_calendar_events');
    expect(names).toContain('get_notes_activity');
    expect(names).toContain('get_now_playing');
  });
});
