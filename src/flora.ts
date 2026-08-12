/**
 * FloraCoordinator — top-level runtime coordinator
 *
 * Owns the ReasoningEngine, SignalCoordinator, NetworkMonitor, and ChatPanel.
 * Called by main.ts after onboarding completes.
 *
 * Responsibility boundary:
 *   - Wires Module E (LLM) output to the avatar brief panel (§7)
 *   - Routes engine proactive triggers through Module E's generateProactiveMessage()
 *   - Drives §13.4 offline behavior: stale brief label, chat disabled, no LLM calls
 *   - Shows §13.2 "confused" state (3 s flash) on integration failure
 *   - Never owns UI state directly — delegates to AvatarRenderer and ChatPanel
 */

import { createReasoningEngine, type ReasoningEngine, type SignalContext } from './llm/reasoning.js';
import { createDefaultDispatcher } from './llm/tools.js';
import { SignalCoordinator } from './signals.js';
import { NetworkMonitor } from './network.js';
import { FloraStateMachine } from './states.js';
import { AvatarRenderer } from './avatar.js';
import { ChatPanel } from './chat.js';
import type { OnboardingResult } from './onboarding.js';

export interface CoordinatorConfig {
  sm: FloraStateMachine;
  renderer: AvatarRenderer;
  chatPanel: ChatPanel;
  onboarding: OnboardingResult;
}

export class FloraCoordinator {
  private sm: FloraStateMachine;
  private renderer: AvatarRenderer;
  private chatPanel: ChatPanel;
  private signals: SignalCoordinator;
  private network: NetworkMonitor;
  private engine: ReasoningEngine | null = null;
  private isOffline = false;
  private staleBriefText: string | null = null;
  private staleBriefTime: Date | null = null;

  constructor({ sm, renderer, chatPanel, onboarding }: CoordinatorConfig) {
    this.sm = sm;
    this.renderer = renderer;
    this.chatPanel = chatPanel;

    // Build the reasoning engine if a key was provided
    if (onboarding.geminiApiKey) {
      this.engine = createReasoningEngine({
        apiKey: onboarding.geminiApiKey,
        toolDispatcher: createDefaultDispatcher({}),  // real integrations injected later
      });
      chatPanel.setEngine(this.engine);
    }

    // Network monitor
    this.network = new NetworkMonitor();
    this.network.onOffline(() => this.handleOffline());
    this.network.onOnline(() => this.handleOnline());

    // Signal coordinator — wires engine proactive slot
    this.signals = new SignalCoordinator(sm);

    this.signals.onProactiveMessage(async (trigger, signalCtx) => {
      await this.handleProactiveMessage(trigger, signalCtx);
    });

    // Chat panel thinking callbacks → sm triggers
    chatPanel.onThinkingStart = () => { sm.trigger('llm_request_start'); };
    chatPanel.onThinkingEnd = () => { sm.trigger('llm_request_end'); };
  }

  /** Start the coordinator — call after all DOM is ready */
  start(): void {
    this.network.start();
    this.signals.start();
  }

  stop(): void {
    this.signals.stop();
    this.network.stop();
  }

  /** Called when the state machine enters 'greeting' — fire a morning brief */
  async onGreeting(signals?: SignalContext): Promise<void> {
    if (this.isOffline) {
      // §13.4: show stale brief, no LLM call
      if (this.staleBriefText && this.staleBriefTime) {
        const timeStr = this.staleBriefTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.renderer.setBriefText(`${this.staleBriefText} · as of ${timeStr}`, true);
        this.renderer.showBrief(true);
      }
      return;
    }

    if (!this.engine) {
      // No LLM — show a minimal "no key" message
      this.renderer.setBriefText(
        'Add a Gemini API key in settings to get your morning brief.',
        false,
      );
      this.renderer.showBrief(true);
      return;
    }

    this.sm.trigger('llm_request_start');
    try {
      const brief = await this.engine.generateMorningBrief(signals ?? {});
      this.sm.trigger('llm_request_end');

      if (brief) {
        this.staleBriefText = brief;
        this.staleBriefTime = new Date();
        this.renderer.setBriefText(brief, false);
        this.renderer.showBrief(true);
      }
      // null → degraded, no error shown (§13.2 "quiet degraded" — brief still absent, no error)
    } catch {
      this.sm.trigger('llm_request_end');
      // Silent degradation — same as null result
    }
  }

  // ── §13.2 confused state ──────────────────────────────────────────────────

  /**
   * Flash the "confused" state with a one-line message for 3 s, then return to idle.
   * Call this when a single integration fails mid-session (e.g., calendar 5xx).
   */
  showConfused(message: string): void {
    this.renderer.showToast(message);
    this.sm.trigger('integration_error');
    // The confused state auto-returns to idle after 3 s (set in STATES)
  }

  // ── §13.4 offline handling ────────────────────────────────────────────────

  private handleOffline(): void {
    this.isOffline = true;
    this.sm.trigger('network_lost');
    this.chatPanel.setOffline(true);

    // Show stale brief if we have one
    if (this.staleBriefText && this.staleBriefTime) {
      const timeStr = this.staleBriefTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.renderer.setBriefText(`${this.staleBriefText} · as of ${timeStr}`, true);
      this.renderer.showBrief(true);
    } else {
      this.renderer.setBriefText('Flora is offline — last brief unavailable.', true);
      this.renderer.showBrief(true);
    }
  }

  private handleOnline(): void {
    this.isOffline = false;
    this.sm.trigger('network_restored');
    this.chatPanel.setOffline(false);
    // Hide stale label — brief will refresh on next greeting
    this.renderer.showBrief(false);
  }

  // ── Proactive messages (Module E wiring) ─────────────────────────────────

  private async handleProactiveMessage(trigger: string, signalCtx: SignalContext): Promise<void> {
    if (this.isOffline || !this.engine) return; // §13.4: no LLM calls when offline

    try {
      const msg = await this.engine.generateProactiveMessage(
        trigger as any,
        signalCtx,
      );
      if (msg) {
        this.renderer.showProactive(msg);
      }
      // null → silent skip (§7)
    } catch {
      // §7: silent failure — proactive messages never surface errors to user
    }
  }
}
