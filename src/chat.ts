/**
 * ChatPanel — §13.4 + §7
 *
 * Minimal in-widget chat UI. Connects to Module E's `chat()` function.
 *
 * §13.4: Disabled with a clear message when offline — never hangs on a failed request.
 * §7:    Shows a retry button when `chat()` returns null (API failure).
 * §13.3: In-widget only, no native OS notifications.
 *
 * Opens when the user clicks the avatar jar.
 * Closes when the user clicks the close button or clicks outside.
 */

import type { ReasoningEngine, ChatMessage } from './llm/reasoning.js';

export class ChatPanel {
  private el: HTMLElement;
  private inputEl: HTMLInputElement;
  private messagesEl: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private offlineBannerEl: HTMLElement;
  private engine: ReasoningEngine | null = null;
  private history: ChatMessage[] = [];
  private isOffline = false;
  private isThinking = false;

  /** Callback fired when a chat request starts (for sm.trigger('llm_request_start')) */
  onThinkingStart?: () => void;
  /** Callback fired when a chat request ends */
  onThinkingEnd?: () => void;

  constructor(panelEl: HTMLElement) {
    this.el = panelEl;
    this.messagesEl = panelEl.querySelector('#chat-messages')!;
    this.inputEl = panelEl.querySelector('#chat-input')!;
    this.sendBtn = panelEl.querySelector('#chat-send')!;
    this.closeBtn = panelEl.querySelector('#chat-close')!;
    this.offlineBannerEl = panelEl.querySelector('#chat-offline-banner')!;

    this.sendBtn.addEventListener('click', () => this.send());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    this.closeBtn.addEventListener('click', () => this.close());
  }

  /** Inject the reasoning engine (called after onboarding completes) */
  setEngine(engine: ReasoningEngine): void {
    this.engine = engine;
  }

  open(): void {
    this.el.classList.add('open');
    if (!this.isOffline) this.inputEl.focus();
  }

  close(): void {
    this.el.classList.remove('open');
  }

  isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  /** §13.4: disable chat panel when network is offline */
  setOffline(offline: boolean): void {
    this.isOffline = offline;
    this.inputEl.disabled = offline;
    this.sendBtn.disabled = offline;
    this.offlineBannerEl.classList.toggle('show', offline);
    if (offline) {
      this.inputEl.placeholder = '';
    } else {
      this.inputEl.placeholder = 'Ask Flora anything…';
    }
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isOffline || this.isThinking) return;

    // Add user message
    this.addMessage('user', text);
    this.inputEl.value = '';
    this.history.push({ role: 'user', content: text });

    if (!this.engine) {
      this.addMessage('flora', "I'm not fully set up yet — add a Gemini API key in settings to chat.");
      return;
    }

    // Show thinking state
    this.isThinking = true;
    this.sendBtn.disabled = true;
    this.onThinkingStart?.();
    const thinkingEl = this.addMessage('flora', '…', true);

    try {
      const reply = await this.engine.chat(this.history);
      thinkingEl.remove();

      if (reply === null) {
        // §7: show retry button on failure
        this.addRetryButton(text);
      } else {
        this.addMessage('flora', reply);
        this.history.push({ role: 'assistant', content: reply });
      }
    } catch {
      thinkingEl.remove();
      this.addRetryButton(text);
    } finally {
      this.isThinking = false;
      this.sendBtn.disabled = false;
      this.onThinkingEnd?.();
    }
  }

  private addMessage(role: 'user' | 'flora', text: string, isThinking = false): HTMLElement {
    const el = document.createElement('div');
    el.className = `chat-msg chat-msg--${role}${isThinking ? ' chat-msg--thinking' : ''}`;
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return el;
  }

  private addRetryButton(originalText: string): void {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg--error';
    el.innerHTML = `Couldn't reach Flora. <button class="chat-retry">Retry</button>`;
    el.querySelector('.chat-retry')!.addEventListener('click', () => {
      el.remove();
      // Re-send: pop the user message from history since send() will re-add it
      this.history.pop();
      this.inputEl.value = originalText;
      this.send();
    });
    this.messagesEl.appendChild(el);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
