import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setApiKey } from '../src/core/settings.mjs';
import { enrich, MODEL } from '../src/core/llm.mjs';

// A local stand-in for the Messages API: records each request, answers with `reply`.
const seen = [];
let reply = () => ({ status: 200, body: message({ translation: 'Honestly, I have no idea.' }) });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const { status, body: out, headers = {} } = reply();
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after-ms': '0', ...headers });
    res.end(JSON.stringify(out));
  });
});

function message(parsed, extra = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: parsed == null ? [] : [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: JSON.stringify(parsed) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  };
}
const apiError = (status, type, msg) => ({ status, body: { type: 'error', error: { type, message: msg } } });

let key = 0;
async function useServer(url) {
  process.env.ANTHROPIC_BASE_URL = url;
  setApiKey(`sk-ant-test-${++key}`); // a new key forces a fresh client with the new base URL
}

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await useServer(`http://127.0.0.1:${server.address().port}`);
});
test.after(() => {
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
  setApiKey(null);
});

const ctx = { sentence: '正直に言うと、よく分からない。', word: '正直', reading: 'しょうじき', gloss: 'honesty' };

test('builds one structured-output request on Opus 5.5 with adaptive thinking and server-side fallback', async () => {
  seen.length = 0;
  const out = await enrich({ ...ctx, need: ['translation'] });
  assert.deepEqual(out, { translation: 'Honestly, I have no idea.' });
  assert.equal(seen.length, 1);
  const { url, headers, body } = seen[0];
  assert.match(url, /^\/v1\/messages/);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(Object.keys(body.output_config.format.schema.properties), ['translation']);
  assert.equal(body.fallbacks, 'default');
  assert.ok(!('betas' in body), 'betas travel as a header, not in the body');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.ok(!/server-side-fallback-2026-06-01/.test(headers['anthropic-beta']), 'the array-form header would 400 with "default"');
  assert.ok(!('temperature' in body) && !('budget_tokens' in (body.thinking ?? {})));
  assert.equal(headers['x-api-key'], `sk-ant-test-${key}`);
  assert.match(body.messages[0].content, /Target word: 正直（しょうじき）/);
  assert.match(body.messages[0].content, /Produce: translation\./);
});

test('asks for every LLM field in one schema and ignores unknown ones', async () => {
  seen.length = 0;
  const parsed = {
    contrast: { question: 'q', optionA: 'a', optionB: 'b', answer: 'a', explanation: 'e' },
    situation: { situation: 's', sentence: '正直に言う', reading: 'しょうじきにいう' },
    translation: 't',
  };
  reply = () => ({ status: 200, body: message(parsed) });
  const out = await enrich({ ...ctx, need: ['contrast', 'situation', 'translation', 'bogus'] });
  assert.deepEqual(out, parsed);
  const schema = seen[0].body.output_config.format.schema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['contrast', 'situation', 'translation']);
  assert.equal(seen.length, 1, 'one round trip');
});

test('nothing to ask means no request at all', async () => {
  seen.length = 0;
  assert.deepEqual(await enrich({ ...ctx, need: ['bogus'] }), {});
  assert.equal(seen.length, 0);
});

test('a refusal is reported, not parsed', async () => {
  reply = () => ({ status: 200, body: message(null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) });
  await assert.rejects(enrich({ ...ctx, need: ['translation'] }), /declined/);
});

test('output that does not match the schema is a clear error', async () => {
  reply = () => ({ status: 200, body: message({ wrong: true }) });
  await assert.rejects(enrich({ ...ctx, need: ['translation'] }), /did not fit the card format/);
});

test('auth, rate-limit, overload and network failures read as plain English', async () => {
  reply = () => apiError(401, 'authentication_error', 'invalid x-api-key');
  await assert.rejects(enrich({ ...ctx, need: ['translation'] }), /rejected the API key/);

  seen.length = 0;
  reply = () => apiError(429, 'rate_limit_error', 'slow down');
  await assert.rejects(enrich({ ...ctx, need: ['translation'] }), /rate-limiting/);
  assert.equal(seen.length, 3, 'the SDK retries a 429 twice before giving up');

  reply = () => apiError(529, 'overloaded_error', 'overloaded');
  await assert.rejects(enrich({ ...ctx, need: ['translation'] }), /temporarily unavailable|API error 529/);

  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  await useServer(`http://127.0.0.1:${port}`);
  try {
    await assert.rejects(enrich({ ...ctx, need: ['translation'] }), /Cannot reach Claude/);
  } finally {
    await useServer(`http://127.0.0.1:${server.address().port}`);
  }
});
