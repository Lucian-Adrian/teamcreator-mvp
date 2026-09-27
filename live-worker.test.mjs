import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './live-worker.mjs';

test('public server never accepts project data or exposes local API', async () => {
  let assetsCalled = false;
  const env = { ASSETS: { fetch: () => { assetsCalled = true; return new Response('asset'); } } };
  const response = await worker.fetch(new Request('https://live.teamcreator.ai/api/projects', { method: 'POST', body: 'private content' }), env);
  assert.equal(response.status, 404);
  assert.equal(assetsCalled, false);
  assert.equal((await response.text()).includes('private content'), false);
  const provider = await worker.fetch(new Request('https://live.teamcreator.ai/api/provider'), env);
  assert.equal((await provider.json()).provider, 'none');
  const health = await worker.fetch(new Request('https://live.teamcreator.ai/api/health'), env);
  assert.equal((await health.json()).storage, 'visitor-browser');
  const html = await worker.fetch(new Request('https://live.teamcreator.ai/'), { ASSETS: { fetch: async () => new Response('<html>ok</html>', { headers: { 'Content-Type': 'text/html' } }) } });
  assert.equal(html.headers.get('Cache-Control'), 'no-cache');
  assert.ok(html.headers.get('Content-Security-Policy').includes("connect-src 'self'"));
});
