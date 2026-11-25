import { describe, it, expect } from 'vitest';

import { sendDesktopNotification, type DesktopBridge } from '../../src/alerts/desktop';

describe('sendDesktopNotification', () => {
  it('uses the bridge when present', () => {
    const calls: Array<[string, string]> = [];
    const bridge: DesktopBridge = {
      notify(title, message) {
        calls.push([title, message]);
      },
    };

    expect(sendDesktopNotification('标题', '内容', { bridge })).toBe(true);
    expect(calls).toEqual([['标题', '内容']]);
  });

  it('returns false when no bridge is supplied', () => {
    expect(sendDesktopNotification('标题', '内容')).toBe(false);
    expect(sendDesktopNotification('标题', '内容', { bridge: null })).toBe(false);
  });

  it('returns false when the bridge throws', () => {
    const bridge: DesktopBridge = {
      notify() {
        throw new Error('toast subsystem exploded');
      },
    };
    expect(sendDesktopNotification('标题', '内容', { bridge })).toBe(false);
  });

  it('returns false when the bridge reports failure', () => {
    const bridge: DesktopBridge = { notify: () => false };
    expect(sendDesktopNotification('标题', '内容', { bridge })).toBe(false);
  });

  it('never throws', () => {
    const bridge: DesktopBridge = {
      notify() {
        throw new Error('boom');
      },
    };
    expect(() => sendDesktopNotification('标题', '内容', { bridge })).not.toThrow();
  });
});
