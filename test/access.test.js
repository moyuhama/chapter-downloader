import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowRequest, pagesOrigin } from '../access.js';
function request(host, origin) {
  const headers = {};
  const allowed = allowRequest({ headers: { host, ...(origin ? { origin } : {}) } }, { setHeader: (k, v) => { headers[k] = v; } });
  return { allowed, headers };
}
test('local UI and configured Pages origin can connect', () => {
  assert.equal(request('127.0.0.1:3789').allowed, true);
  assert.equal(request('localhost:3789', 'http://localhost:3789').allowed, true);
  assert.equal(request('[::1]:3789', 'http://[::1]:3789').allowed, true);
  const pages = request('127.0.0.1:3789', pagesOrigin);
  assert.equal(pages.allowed, true);
  assert.equal(pages.headers['Access-Control-Allow-Origin'], pagesOrigin);
  assert.equal(pages.headers['Access-Control-Allow-Private-Network'], 'true');
  assert.equal(pages.headers['Vary'], 'Origin');
});
test('unrelated sites and forged non-loopback host are rejected', () => {
  for (const origin of ['https://attacker.example', 'https://moyuhama.github.io.attacker.example', 'null']) {
    const r = request('127.0.0.1:3789', origin);
    assert.equal(r.allowed, false); assert.deepEqual(r.headers, {});
  }
  assert.equal(request('attacker.example:3789', pagesOrigin).allowed, false);
});
