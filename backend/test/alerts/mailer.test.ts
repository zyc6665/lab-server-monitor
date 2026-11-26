import { describe, it, expect } from 'vitest';

import {
  buildMessage,
  sendReport,
  type MailClient,
  type MailMessage,
  type SmtpConfig,
} from '../../src/alerts/mailer';

/** In-memory fake mirroring the Python `FakeSMTP` call sequence. */
class FakeClient implements MailClient {
  loggedIn: [string, string] | null = null;
  sent: MailMessage | null = null;
  startedTls = false;
  closed = false;

  sendMail(message: MailMessage): unknown {
    this.sent = message;
    return {};
  }

  starttls(): void {
    this.startedTls = true;
  }

  login(username: string, password: string): void {
    this.loggedIn = [username, password];
  }

  close(): void {
    this.closed = true;
  }
}

class FailingAuthClient extends FakeClient {
  override login(): never {
    throw Object.assign(new Error('auth failed'), { code: 'EAUTH' });
  }
}

function smtpConfig(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: 'smtp.example.com',
    port: 465,
    username: 'monitor@example.com',
    password: 'secret',
    useSsl: true,
    fromAddr: 'monitor@example.com',
    toAddrs: ['ops@example.com'],
    ...overrides,
  };
}

const message = buildMessage({
  subject: 'daily',
  fromAddr: 'monitor@example.com',
  toAddrs: ['ops@example.com'],
  textBody: 'plain',
  htmlBody: '<html><body>html</body></html>',
});

describe('buildMessage', () => {
  it('builds a message with subject/from/to/text/html', () => {
    expect(message.subject).toBe('daily');
    expect(message.from).toBe('monitor@example.com');
    expect(message.to).toBe('ops@example.com');
    expect(message.text).toBe('plain');
    expect(message.html).toBe('<html><body>html</body></html>');
  });

  it('joins multiple recipients with a comma', () => {
    const multi = buildMessage({
      subject: 's',
      fromAddr: 'from@example.com',
      toAddrs: ['a@example.com', 'b@example.com'],
      textBody: 't',
      htmlBody: '<p>h</p>',
    });
    expect(multi.to).toBe('a@example.com, b@example.com');
  });
});

describe('sendReport', () => {
  it('uses the SSL client factory when use_ssl is true', async () => {
    const fake = new FakeClient();
    await sendReport(smtpConfig({ useSsl: true }), message, {
      smtpSslFactory: (host, port) => {
        expect(host).toBe('smtp.example.com');
        expect(port).toBe(465);
        return fake;
      },
    });

    expect(fake.loggedIn).toEqual(['monitor@example.com', 'secret']);
    expect(fake.sent?.to).toBe('ops@example.com');
    expect(fake.startedTls).toBe(false);
    expect(fake.closed).toBe(true);
  });

  it('uses the STARTTLS client factory when use_ssl is false', async () => {
    const fake = new FakeClient();
    await sendReport(smtpConfig({ port: 587, useSsl: false }), message, {
      smtpFactory: () => fake,
    });

    expect(fake.startedTls).toBe(true);
    expect(fake.loggedIn).toEqual(['monitor@example.com', 'secret']);
    expect(fake.sent?.to).toBe('ops@example.com');
  });

  it('retries a transient network failure and then succeeds', async () => {
    const fake = new FakeClient();
    let attempts = 0;
    const sleeps: number[] = [];

    await sendReport(smtpConfig(), message, {
      smtpSslFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('socket disconnected'), { code: 'ESOCKET' });
        }
        return fake;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([3000]);
    expect(fake.sent?.to).toBe('ops@example.com');
  });

  it('rethrows after exhausting all attempts', async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    await expect(
      sendReport(smtpConfig(), message, {
        smtpSslFactory: () => {
          attempts += 1;
          throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      })
    ).rejects.toThrow('timed out');

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([3000, 6000]);
  });

  it('does not retry an authentication failure', async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    await expect(
      sendReport(smtpConfig(), message, {
        smtpSslFactory: () => {
          attempts += 1;
          return new FailingAuthClient();
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      })
    ).rejects.toThrow('auth failed');

    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('honours custom retries and delayMs', async () => {
    let attempts = 0;
    const sleeps: number[] = [];

    await expect(
      sendReport(smtpConfig(), message, {
        smtpSslFactory: () => {
          attempts += 1;
          throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        },
        retries: 2,
        delayMs: 1000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      })
    ).rejects.toThrow('timed out');

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it('propagates a non-retryable error immediately', async () => {
    let attempts = 0;

    await expect(
      sendReport(smtpConfig(), message, {
        smtpSslFactory: () => {
          attempts += 1;
          throw new Error('bad configuration');
        },
        sleep: async () => undefined,
      })
    ).rejects.toThrow('bad configuration');

    expect(attempts).toBe(1);
  });
});
