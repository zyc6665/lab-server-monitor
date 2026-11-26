import { describe, expect, it } from 'vitest';

import { createUserScanRunnerFactory } from '../../src/users/collection';

describe('user-scan runner timeout units', () => {
  it('converts whole-second budgets to milliseconds for the SSH client', async () => {
    const seen: number[] = [];
    const makeClient = () => ({
      run: async (_c: string, ms: number) => {
        seen.push(ms);
        return { exitStatus: 0, stdout: '', stderr: '' };
      },
      runSudo: async (_c: string, _p: string, ms: number) => {
        seen.push(ms);
        return { exitStatus: 0, stdout: '', stderr: '' };
      },
      close: () => {},
    });
    const factory = createUserScanRunnerFactory(
      { connectTimeoutSec: 10, hostKeyPolicy: 'accept-new' },
      makeClient as never,
    );
    const runner = factory({ name: 'h', host: '127.0.0.1', port: 22, username: 'u', auth: { type: 'password', password: 'p' } } as never, 10);
    await runner.run('scan', 120);
    await runner.runSudo('du', 15);
    expect(seen).toEqual([120_000, 15_000]);
  });
});
