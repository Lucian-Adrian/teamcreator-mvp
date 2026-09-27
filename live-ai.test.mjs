import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAI, validateExtraction } from './live-ai.mjs';

const input = { documents: [{ source_id: 'source-1', name: 'synthetic.txt', text: 'Task Alpha is due 2026-10-05.' }], records: [] };
const output = { items: [{ record_kind: 'task', title: 'Alpha', record_id: null,
  fields: { description: null, role: null, member_type: null, status: null, owner: null, due: '2026-10-05', completed_at: null, baseline_due: null, current_forecast: null, depends_on_titles: [] },
  source_refs: [{ source_id: 'source-1', location: 'line 1', quote: 'Task Alpha is due 2026-10-05.' }] }], missing_info: ['Owner is unknown.'] };
const env = { TC_AI_API_KEY: 'synthetic-test-only', TC_AI_MODEL: 'test-model', TC_ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com', TC_ACCESS_AUD: 'test-audience', AI_LIMITER: { limit: async () => ({ success: true }) } };
const request = (body = input) => new Request('https://live.teamcreator.ai/api/ai/extract', { method: 'POST', headers: { Origin: 'https://live.teamcreator.ai', 'Content-Type': 'application/json', 'X-TeamCreator-AI': '1' }, body: JSON.stringify(body) });

test('AI remains closed without config, origin, or verified identity', async () => {
  assert.equal((await handleAI(request(), {})).status, 503);
  assert.equal((await handleAI(new Request('https://live.teamcreator.ai/api/ai/extract', { method: 'POST' }), env)).status, 403);
  assert.equal((await handleAI(request(), env)).status, 401);
});

test('AI validates bounded input and exact source quotes; errors never expose credential', async () => {
  let providerCalls = 0;
  const dependencies = { authenticate: async () => 'synthetic-user', fetch: async (url, init) => {
    providerCalls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert.equal(body.tools, undefined);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
  } };
  const success = await handleAI(request(), env, dependencies);
  assert.equal(success.status, 200); assert.equal((await success.json()).provider_mode, 'model');
  assert.equal((await handleAI(request({ ...input, documents: [{ ...input.documents[0], text: 'x'.repeat(48001) }] }), env, dependencies)).status, 400);
  assert.equal(providerCalls, 1);
  assert.throws(() => validateExtraction({ ...output, items: [{ ...output.items[0], source_refs: [{ source_id: 'source-1', location: 'line 1', quote: 'Fabricated' }] }] }, input));
  assert.throws(() => validateExtraction({ ...output, items: [{ ...output.items[0], record_id: 'unknown-target' }] }, input));
  const failure = await handleAI(request(), env, { ...dependencies, fetch: async () => { throw new Error(env.TC_AI_API_KEY); } });
  assert.equal(failure.status, 502); assert.equal((await failure.text()).includes(env.TC_AI_API_KEY), false);
  const limited = await handleAI(request(), { ...env, AI_LIMITER: { limit: async () => ({ success: false }) } }, dependencies);
  assert.equal(limited.status, 429);
});

test('validated AI citations use the matched source line even when the model locator is wrong', () => {
  const sourceText = '[schedule.txt, line 1]: Delivery header\n[schedule.txt, line 2]: Task Alpha is due 2026-10-05.';
  const sourceInput = { documents: [{ source_id: 'source-1', name: 'schedule.txt', text: sourceText }], records: [] };
  const sourceOutput = structuredClone(output);
  sourceOutput.items[0].source_refs[0].location = 'line 999';
  const parsed = validateExtraction(sourceOutput, sourceInput);
  assert.equal(parsed.items[0].source_refs[0].location, 'line 2');
});
