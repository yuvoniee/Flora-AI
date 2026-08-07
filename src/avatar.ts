/**
 * Flora Avatar Renderer
 *
 * Mirrors the preview's setState() — swaps `is-*` classes on the jar
 * element, updates the --accent CSS variable, and toggles brief visibility.
 * All visual behavior lives in CSS, not here.
 */

import { STATES, StateConfig } from './states';

export class AvatarRenderer {
  private jarEl: HTMLElement;
  private labelEl: HTMLElement;
  private briefEl: HTMLElement;

  constructor(jarEl: HTMLElement, labelEl: HTMLElement, briefEl: HTMLElement) {
    this.jarEl = jarEl;
    this.labelEl = labelEl;
    this.briefEl = briefEl;
  }

  /** Apply a new state visually — same logic as preview's setState() */
  update(stateName: string, config: StateConfig): void {
    // Remove all is-* state classes
    for (const key of Object.keys(STATES)) {
      this.jarEl.classList.remove('is-' + key);
    }

    // Apply new state class
    this.jarEl.classList.add('is-' + stateName);

    // Update accent color driving glow, leaves, stem, head
    document.documentElement.style.setProperty('--accent', config.color);

    // Update label
    this.labelEl.textContent = config.label;

    // Toggle morning-brief panel (greeting only)
    this.briefEl.classList.toggle('show', stateName === 'greeting');
  }
}
