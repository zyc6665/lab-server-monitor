import { describe, it, expect } from 'vitest';
import { startServer } from '../src/server';

describe('health', () => {
  it('GET /api/system/health -> 200 {status:ok}', async () => {
    const s = await startServer({ port: 0 });
    try {
      const r = await fetch(s.url + '/api/system/health');
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ status: 'ok' });
    } finally {
      await s.close();
    }
  });
});
