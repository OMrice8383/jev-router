import assert from 'node:assert/strict';
import { loadPolicy } from '../dist/core/index.js';
import { startDaemon } from '../dist/daemon/index.js';
let release, entered;
const gate = new Promise(r => { release = r; });
const started = new Promise(r => { entered = r; });
const daemon = await startDaemon({ policy: loadPolicy({ version: 1, judge: { transport: 'mock' }, egress: { test: { base_url: 'http://upstream.invalid', no_auth: true } }, candidates: { fast: { model: 'test', via: 'test', price: { in: 0, out: 0 } } }, routes: [{ id: 'auto', harness: 'any', policy: 'test' }], policies: { test: { default: 'fast', rules: [] } } }), host: '127.0.0.1', port: 0, fetch: async () => { entered(); await gate; return new Response(JSON.stringify({ model: 'test', content: [{ type: 'text', text: 'done' }] }), { headers: { 'content-type': 'application/json' } }); } });
const response = fetch(daemon.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] }) }).then(r => r.text(), () => 'interrupted');
try {
  await started;
  let closed = false;
  const closing = daemon.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(closed, false, 'shutdown must wait for the active response');
  release();
  assert.match(await response, /done/);
  await closing;
  console.log('graceful-smoke: active response completed before shutdown');
} finally {
  release();
  await response;
  await daemon.close();
}
