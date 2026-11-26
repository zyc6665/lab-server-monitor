/**
 * Desktop toast notifications, ported from `servermanage/notify_desktop.py`.
 *
 * The Python oracle prefers `winotify` and falls back to a PowerShell WinRT
 * toast. In the single-stack rewrite the toast is delivered by the Electron
 * main process (P6 bridge); this module therefore just models that contract:
 * if an injected `bridge` with a `notify(title, message)` method is present it
 * is used, otherwise the notification is treated as unavailable.  Like Python,
 * this function never raises — any bridge failure becomes `false` so the
 * composite notifier can isolate a failing channel.
 */

/** Desktop notification bridge supplied by the Electron shell (P6). */
export interface DesktopBridge {
  notify(title: string, message: string): unknown;
}

export interface SendDesktopOptions {
  /** Optional desktop bridge; absent on headless / test hosts. */
  bridge?: DesktopBridge | null;
}

/**
 * Shows a desktop toast via `bridge` when available.
 *
 * Returns `true` when the bridge accepted the notification (or produced no
 * explicit failure), `false` when the bridge is missing, throws, or returns
 * `false`.  Never throws.
 */
export function sendDesktopNotification(
  title: string,
  message: string,
  options: SendDesktopOptions = {}
): boolean {
  const bridge = options.bridge;
  if (!bridge || typeof bridge.notify !== 'function') {
    return false;
  }
  try {
    const result = bridge.notify(title, message);
    return result !== false;
  } catch {
    // A toast failure must never break alert dispatch.
    return false;
  }
}
