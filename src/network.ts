/**
 * NetworkMonitor — §13.4 offline detection
 *
 * Wraps `navigator.onLine` and the browser `online`/`offline` events.
 * Works in Tauri's WebView and plain browsers alike.
 *
 * Usage:
 *   const net = new NetworkMonitor();
 *   net.onOffline(() => sm.trigger('network_lost'));
 *   net.onOnline(() => sm.trigger('network_restored'));
 *   net.start();
 */

export type NetworkCallback = () => void;

export class NetworkMonitor {
  private offlineCallbacks: NetworkCallback[] = [];
  private onlineCallbacks: NetworkCallback[] = [];
  private started = false;

  private handleOffline = (): void => {
    console.log('[Flora/network] Connection lost — going offline');
    for (const cb of this.offlineCallbacks) cb();
  };

  private handleOnline = (): void => {
    console.log('[Flora/network] Connection restored');
    for (const cb of this.onlineCallbacks) cb();
  };

  /** Register a callback fired when the network goes away */
  onOffline(cb: NetworkCallback): void {
    this.offlineCallbacks.push(cb);
  }

  /** Register a callback fired when the network comes back */
  onOnline(cb: NetworkCallback): void {
    this.onlineCallbacks.push(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('offline', this.handleOffline);
    window.addEventListener('online', this.handleOnline);

    // Fire immediately if already offline at startup
    if (!navigator.onLine) {
      // Defer one tick so listeners have been registered by the time it fires
      setTimeout(() => this.handleOffline(), 0);
    }
  }

  stop(): void {
    window.removeEventListener('offline', this.handleOffline);
    window.removeEventListener('online', this.handleOnline);
    this.started = false;
  }

  /** Current connectivity — safe to call at any time */
  isOnline(): boolean {
    return navigator.onLine;
  }
}
