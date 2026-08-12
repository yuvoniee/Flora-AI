/**
 * Module E — LLM Reasoning Standalone CLI Runner
 *
 * Tests all three reasoning functions against the real Gemini API (gemini-2.0-flash).
 * Reads GEMINI_API_KEY from env — never hardcoded.
 *
 * ⚠️  FREE-TIER NOTE: Free-tier Gemini requests may be used by Google to improve
 * their models. Swap to a paid tier before handling real personal data long-term.
 *
 * Usage:
 *   npx tsx src/llm/reasoning.cli.ts --print-sheet      # print & review character sheet
 *   npx tsx src/llm/reasoning.cli.ts --brief            # morning brief (real API)
 *   npx tsx src/llm/reasoning.cli.ts --proactive focus_break
 *   npx tsx src/llm/reasoning.cli.ts --chat "What's on today?"
 *   npx tsx src/llm/reasoning.cli.ts --test-failure     # simulates API timeout → null
 *   npx tsx src/llm/reasoning.cli.ts --review-sheet     # 10 tone-consistency samples
 *
 * §7 acceptance criteria verified:
 *   --print-sheet     → character sheet is a readable, frozen standalone document
 *   --brief           → morning brief with all/partial/no data
 *   --test-failure    → returns null, never throws
 *   --review-sheet    → 10 sample prompts to verify tone consistency
 */

import {
  createReasoningEngine,
  countSentences,
  type SignalContext,
  type ChatMessage,
  type WindowCategory,
} from './reasoning.js';
import {
  FLORA_CHARACTER_SHEET,
  FLORA_SYSTEM_PROMPT,
  type ProactiveTrigger,
} from './character-sheet.js';
import { createDefaultDispatcher } from './tools.js';
import { getWeather } from '../weather.js';
import { getTodayEvents } from '../calendar.js';
import { getRecentFiles } from '../files.js';
import { getNowPlaying } from '../spotify.js';

// ── CLI args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const printSheet = args.includes('--print-sheet');
const reviewSheet = args.includes('--review-sheet');
const testFailure = args.includes('--test-failure');
const doBrief = args.includes('--brief');
const doProactive = args.includes('--proactive');
const doChat = args.includes('--chat');

const proactiveTrigger = doProactive ? (args[args.indexOf('--proactive') + 1] as ProactiveTrigger) : null;
const chatMessage = doChat ? args.slice(args.indexOf('--chat') + 1).join(' ') : null;

// ── Engine setup ───────────────────────────────────────────────────────────────

function buildEngine(apiKey: string, simulateTimeout = false) {
  const dispatcher = createDefaultDispatcher({
    getWeather,
    getTodayEvents: () => getTodayEvents(),
    getRecentFiles,
    getNowPlaying: () => getNowPlaying(),
  });

  return createReasoningEngine({
    apiKey,
    timeoutMs: simulateTimeout ? 1 : 15_000,
    toolDispatcher: dispatcher,
  });
}

// ── Sample signals ─────────────────────────────────────────────────────────────

function getSampleSignals(): SignalContext {
  const hour = new Date().getHours();
  return {
    timeOfDay: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening',
    windowCategory: 'code_editor' as WindowCategory,
  };
}

// ── §7 review sheet: 10 tone-consistency samples ───────────────────────────────

const REVIEW_SAMPLES: Array<{ label: string; fn: (engine: ReturnType<typeof buildEngine>) => Promise<string | null> }> = [
  {
    label: 'Morning brief — all data',
    fn: (e) => e.generateMorningBrief({ timeOfDay: 'morning', windowCategory: 'code_editor' }),
  },
  {
    label: 'Morning brief — no context',
    fn: (e) => e.generateMorningBrief(),
  },
  {
    label: 'Proactive: focus_break',
    fn: (e) => e.generateProactiveMessage('focus_break', { focusDurationMs: 90 * 60_000, windowCategory: 'code_editor' }),
  },
  {
    label: 'Proactive: long_idle',
    fn: (e) => e.generateProactiveMessage('long_idle', { idleDurationMs: 25 * 60_000 }),
  },
  {
    label: 'Proactive: new_event',
    fn: (e) => e.generateProactiveMessage('new_event', { timeOfDay: 'afternoon' }),
  },
  {
    label: 'Proactive: now_playing',
    fn: (e) => e.generateProactiveMessage('now_playing'),
  },
  {
    label: 'Proactive: morning_startup',
    fn: (e) => e.generateProactiveMessage('morning_startup', { timeOfDay: 'morning' }),
  },
  {
    label: 'Chat: calendar query',
    fn: (e) => e.chat([{ role: 'user', content: "What's on my calendar today?" }]),
  },
  {
    label: 'Chat: general question',
    fn: (e) => e.chat([{ role: 'user', content: 'What should I focus on right now?' }]),
  },
  {
    label: 'Chat: weather',
    fn: (e) => e.chat([{ role: 'user', content: 'What\'s the weather like?' }]),
  },
];

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Print character sheet (§7: reviewable independently) ─────────────────
  if (printSheet) {
    console.log('\n' + '═'.repeat(64));
    console.log('FLORA CHARACTER SHEET — FROZEN v1');
    console.log('═'.repeat(64));
    console.log(FLORA_CHARACTER_SHEET);
    console.log('─'.repeat(64));
    console.log(`System prompt length: ${FLORA_SYSTEM_PROMPT.length} characters`);
    console.log(`Review before wiring: read every rule, check for ambiguity.`);
    console.log(`Freeze commit: git commit -m "freeze: flora character sheet v1"`);
    return;
  }

  // ── Simulated API failure (§7 acceptance test) ────────────────────────────
  if (testFailure) {
    console.log('\n=== Testing §7 error handling: simulated API timeout ===\n');

    const engine = buildEngine('test-key-not-used', true);
    const brief = await engine.generateMorningBrief();
    const proactive = await engine.generateProactiveMessage('focus_break');

    console.log(`generateMorningBrief:     ${brief === null ? '✅ returned null (no throw)' : '❌ expected null'}`);
    console.log(`generateProactiveMessage: ${proactive === null ? '✅ returned null silently' : '❌ expected null'}`);
    return;
  }

  // All remaining modes need a real API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      '❌ GEMINI_API_KEY not set.\n' +
      '   Set GEMINI_API_KEY=<your-key> and re-run.\n' +
      '   In production the key is read from the OS keychain — never hardcoded.\n' +
      '   ⚠️  Free-tier requests may be used by Google to improve their models.'
    );
    process.exit(1);
  }

  // ── Review sheet: 10 tone-consistency samples ─────────────────────────────
  if (reviewSheet) {
    console.log('\n=== Flora Character Sheet — 10 Tone Consistency Samples ===');
    console.log('Review each output against the character sheet rules.\n');

    const engine = buildEngine(apiKey);
    let passed = 0;

    for (let i = 0; i < REVIEW_SAMPLES.length; i++) {
      const sample = REVIEW_SAMPLES[i];
      console.log(`\n[${i + 1}/10] ${sample.label}`);
      console.log('─'.repeat(50));

      try {
        const result = await sample.fn(engine);
        if (result === null) {
          console.log('⚠️  Returned null (API failure or no content)');
        } else {
          console.log(result);
          const sentences = countSentences(result);
          if (sample.label.startsWith('Proactive')) {
            console.log(`\n[${sentences <= 2 ? '✅' : '❌'} ${sentences} sentence(s) — limit: 2]`);
            if (sentences <= 2) passed++;
          } else {
            console.log(`\n[ℹ️  ${sentences} sentence(s)]`);
            passed++;
          }
        }
      } catch (err: any) {
        console.log(`❌ Threw: ${err.message}`);
      }
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Tone review: ${passed}/${REVIEW_SAMPLES.length} samples within constraints`);
    return;
  }

  // ── Morning brief ─────────────────────────────────────────────────────────
  if (doBrief) {
    console.log('\n=== Flora Morning Brief (Module E CLI) ===\n');
    const engine = buildEngine(apiKey);
    const signals = getSampleSignals();
    console.log(`Signals: ${JSON.stringify(signals)}\n`);

    const start = Date.now();
    const brief = await engine.generateMorningBrief(signals);
    const elapsed = Date.now() - start;

    if (brief === null) {
      console.log('⚠️  Brief returned null (API failure or timeout — graceful degradation)');
    } else {
      console.log(brief);
      console.log(`\n[${countSentences(brief)} sentences, ${brief.length} chars, ${elapsed}ms]`);
    }
    return;
  }

  // ── Proactive message ─────────────────────────────────────────────────────
  if (doProactive && proactiveTrigger) {
    const validTriggers: ProactiveTrigger[] = ['focus_break', 'long_idle', 'new_event', 'now_playing', 'morning_startup', 'focus_ended'];
    if (!validTriggers.includes(proactiveTrigger)) {
      console.error(`❌ Unknown trigger: "${proactiveTrigger}"`);
      console.error(`   Valid: ${validTriggers.join(', ')}`);
      process.exit(1);
    }

    console.log(`\n=== Flora Proactive Message: ${proactiveTrigger} ===\n`);
    const engine = buildEngine(apiKey);

    const start = Date.now();
    const msg = await engine.generateProactiveMessage(proactiveTrigger, getSampleSignals());
    const elapsed = Date.now() - start;

    if (msg === null) {
      console.log('⚠️  Returned null (silent failure — expected behaviour for proactive messages)');
    } else {
      console.log(msg);
      const sentences = countSentences(msg);
      console.log(`\n[${sentences <= 2 ? '✅' : '❌'} ${sentences} sentence(s) — limit: 2, ${elapsed}ms]`);
    }
    return;
  }

  // ── Direct chat ────────────────────────────────────────────────────────────
  if (doChat && chatMessage) {
    console.log(`\n=== Flora Chat ===\n`);
    console.log(`You: ${chatMessage}\n`);
    const engine = buildEngine(apiKey);

    const messages: ChatMessage[] = [{ role: 'user', content: chatMessage }];
    const start = Date.now();
    const reply = await engine.chat(messages);
    const elapsed = Date.now() - start;

    if (reply === null) {
      console.log('⚠️  Chat returned null (API failure — caller should show retry UI)');
    } else {
      console.log(`Flora: ${reply}`);
      console.log(`\n[${elapsed}ms]`);
    }
    return;
  }

  // ── Help ───────────────────────────────────────────────────────────────────
  console.log(`
Flora LLM Reasoning CLI (Module E)

  --print-sheet                   Print & review the character sheet
  --review-sheet                  Run 10 tone-consistency samples (requires API key)
  --test-failure                  Simulate API timeout → null (§7 acceptance test)
  --brief                         Generate a morning brief
  --proactive <trigger>           Generate a proactive message
      Triggers: focus_break | long_idle | new_event | now_playing | morning_startup | focus_ended
  --chat "<message>"              Direct chat

Environment:
  GEMINI_API_KEY=<key>            Required for all modes except --print-sheet and --test-failure
                                  Free tier: data may be used for model training. Use paid tier
                                  before handling real personal data.
`);
}

main().catch((err) => {
  console.error('\n❌ Unexpected error in reasoning CLI:', err.message);
  process.exit(1);
});
