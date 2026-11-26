import { describe, it, expect, afterEach } from 'vitest';

import {
  buildWebhookPayload,
  sendWebhook,
  nowIsoLocal,
  type WebhookAlertEvent,
  type WebhookConfig,
} from '../../src/alerts/webhook';

const EVENT: WebhookAlertEvent = {
  host_name: 'gpu-01',
  severity: 'warning',
  title: 'CPU 使用率过高',
  message: 'CPU 95.0% 达到阈值 90%',
  fingerprint: 'system:gpu-01:cpu',
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recordingFetch(
  status: number,
  body: string | undefined,
  calls: RecordedCall[]
): (url: string, init: RequestInit) => Promise<{ status: number; text: () => Promise<string> }> {
  return async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => body ?? '' };
  };
}

afterEach(() => {
  delete process.env.TEST_ALERT_HOOK_URL;
  delete process.env.ALERT_WEBHOOK_URL;
});

describe('buildWebhookPayload', () => {
  it('builds a WeCom text payload', () => {
    const payload = buildWebhookPayload('wecom', EVENT);
    expect(payload.msgtype).toBe('text');
    const text = payload.text as Record<string, string>;
    expect(Object.keys(text)).toEqual(['content']);
    expect(text.content).toContain('warning');
    expect(text.content).toContain('CPU 使用率过高');
    expect(text.content).toContain('CPU 95.0% 达到阈值 90%');
    expect(text.content).toContain('gpu-01');
  });

  it('builds a DingTalk text payload', () => {
    const payload = buildWebhookPayload('dingtalk', EVENT);
    expect(payload.msgtype).toBe('text');
    const text = payload.text as Record<string, string>;
    expect(Object.keys(text)).toEqual(['content']);
    expect(text.content).toContain('CPU 使用率过高');
  });

  it('builds a Feishu text payload', () => {
    const payload = buildWebhookPayload('feishu', EVENT);
    expect(payload.msg_type).toBe('text');
    const content = payload.content as Record<string, string>;
    expect(Object.keys(content)).toEqual(['text']);
    expect(content.text).toContain('warning');
    expect(content.text).toContain('gpu-01');
  });

  it('builds a flat generic payload', () => {
    const payload = buildWebhookPayload('generic', EVENT);
    expect(payload.host).toBe('gpu-01');
    expect(payload.severity).toBe('warning');
    expect(payload.title).toBe('CPU 使用率过高');
    expect(payload.message).toBe('CPU 95.0% 达到阈值 90%');
    expect(typeof payload.timestamp).toBe('string');
    expect(payload.timestamp).toBeTruthy();
  });

  it('treats an unknown kind as generic', () => {
    const payload = buildWebhookPayload('slack', EVENT);
    expect(payload.host).toBe('gpu-01');
    expect(payload.severity).toBe('warning');
  });

  it('is case/whitespace insensitive for the kind', () => {
    const payload = buildWebhookPayload('  DingTalk ', EVENT);
    expect(payload.msgtype).toBe('text');
  });
});

describe('nowIsoLocal', () => {
  it('renders local time with second precision and a numeric offset', () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    expect(nowIsoLocal(date)).toMatch(/^\d{4}-\d{2}-\d{2}T03:04:05[+-]\d{2}:\d{2}$/);
    expect(nowIsoLocal(date).startsWith('2026-01-02T03:04:05')).toBe(true);
  });
});

describe('sendWebhook', () => {
  it('posts JSON to the configured generic URL', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = {
      enabled: true,
      type: 'generic',
      url: 'https://example.com/hook',
      urlEnv: null,
    };

    const ok = await sendWebhook('generic', EVENT, config, {
      fetchImpl: recordingFetch(200, undefined, calls),
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/hook');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.host).toBe('gpu-01');
    expect(body.severity).toBe('warning');
    expect(calls[0].init.signal).toBeDefined();
  });

  it('returns true for Feishu code 0', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'feishu', url: 'https://open.feishu.cn/hook' };
    const ok = await sendWebhook('feishu', EVENT, config, {
      fetchImpl: recordingFetch(200, JSON.stringify({ code: 0, msg: 'success' }), calls),
    });
    expect(ok).toBe(true);
  });

  it('returns false for a Feishu application error', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'feishu', url: 'https://open.feishu.cn/hook' };
    const ok = await sendWebhook('feishu', EVENT, config, {
      fetchImpl: recordingFetch(200, JSON.stringify({ code: 9499, msg: 'Bad Request' }), calls),
    });
    expect(ok).toBe(false);
  });

  it('returns false for a WeCom errcode error', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'wecom', url: 'https://qyapi.weixin.qq.com/hook' };
    const ok = await sendWebhook('wecom', EVENT, config, {
      fetchImpl: recordingFetch(200, JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }), calls),
    });
    expect(ok).toBe(false);
  });

  it('returns true for a WeCom errcode 0', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'wecom', url: 'https://qyapi.weixin.qq.com/hook' };
    const ok = await sendWebhook('wecom', EVENT, config, {
      fetchImpl: recordingFetch(200, JSON.stringify({ errcode: 0, errmsg: 'ok' }), calls),
    });
    expect(ok).toBe(true);
  });

  it('treats a non-JSON 2xx body as success', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'generic', url: 'https://example.com/hook' };
    const ok = await sendWebhook('generic', EVENT, config, {
      fetchImpl: recordingFetch(200, 'not json', calls),
    });
    expect(ok).toBe(true);
  });

  it('reads the URL from the named environment variable', async () => {
    process.env.TEST_ALERT_HOOK_URL = 'https://env.example/hook';
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'wecom', url: null, urlEnv: 'TEST_ALERT_HOOK_URL' };

    const ok = await sendWebhook('wecom', EVENT, config, {
      fetchImpl: recordingFetch(200, undefined, calls),
    });

    expect(ok).toBe(true);
    expect(calls[0].url).toBe('https://env.example/hook');
  });

  it('accepts the snake_case url_env form', async () => {
    process.env.TEST_ALERT_HOOK_URL = 'https://env2.example/hook';
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'wecom', url: null, url_env: 'TEST_ALERT_HOOK_URL' };

    const ok = await sendWebhook('wecom', EVENT, config, {
      fetchImpl: recordingFetch(200, undefined, calls),
    });

    expect(ok).toBe(true);
    expect(calls[0].url).toBe('https://env2.example/hook');
  });

  it('returns false without calling fetch when no URL is configured', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'wecom', url: null, urlEnv: 'ALERT_WEBHOOK_URL' };
    const ok = await sendWebhook('wecom', EVENT, config, {
      fetchImpl: recordingFetch(200, undefined, calls),
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('returns false on a network error', async () => {
    const config: WebhookConfig = { enabled: true, type: 'wecom', url: 'https://example.com/hook' };
    const ok = await sendWebhook('wecom', EVENT, config, {
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    });
    expect(ok).toBe(false);
  });

  it('returns false on a non-2xx status', async () => {
    const calls: RecordedCall[] = [];
    const config: WebhookConfig = { enabled: true, type: 'wecom', url: 'https://example.com/hook' };
    const ok = await sendWebhook('wecom', EVENT, config, {
      fetchImpl: recordingFetch(500, undefined, calls),
    });
    expect(ok).toBe(false);
  });

  it('returns false when the request times out', async () => {
    const config: WebhookConfig = { enabled: true, type: 'generic', url: 'https://example.com/hook' };
    const slowFetch = (_url: string, init: RequestInit): Promise<{ status: number; text: () => Promise<string> }> =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }
      });

    const ok = await sendWebhook('generic', EVENT, config, {
      fetchImpl: slowFetch,
      timeoutMs: 10,
    });
    expect(ok).toBe(false);
  });
});
