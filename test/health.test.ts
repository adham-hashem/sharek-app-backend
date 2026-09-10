import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'abcdefghijklmnopqrstuv';

const { app } = await import('../src/server.js');

test('health endpoint is public and deterministic', async () => {
  const response = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
});

test('protected API rejects missing bearer token', async () => {
  const response = await app.inject({ method: 'GET', url: '/v1/me' });
  assert.equal(response.statusCode, 401);
});

test.after(async () => { await app.close(); });
