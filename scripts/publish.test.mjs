import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./publish.mjs', import.meta.url));
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const key = JSON.stringify({ type: 'service_account', client_email: 'test@example.invalid', private_key: privateKey });
const fixture = mkdtempSync(join(tmpdir(), 'cws-publish-test-'));
const zip = join(fixture, 'extension.zip');
writeFileSync(zip, 'test package bytes');
test.after(() => rmSync(fixture, { recursive: true, force: true }));

function run(scenario, overrides = {}) {
  const preload = `
    import assert from 'node:assert/strict';
    const scenario = ${JSON.stringify(scenario)};
    globalThis.setTimeout = (callback) => { callback(); return 0; };
    globalThis.fetch = async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        assert.equal(options.method, 'POST');
        assert.ok(options.body.get('assertion').split('.').length === 3);
        if (scenario === 'token-failure') return new Response(JSON.stringify({error:'DO_NOT_LOG_TOKEN_BODY'}), {status:403});
        return Response.json({access_token:'DO_NOT_LOG_ACCESS_TOKEN'});
      }
      assert.equal(options.headers.Authorization, 'Bearer DO_NOT_LOG_ACCESS_TOKEN');
      if (url.endsWith(':upload')) {
        console.log('TEST_UPLOAD');
        assert.equal(url, 'https://chromewebstore.googleapis.com/upload/v2/publishers/test-publisher/items/' + 'a'.repeat(32) + ':upload');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/zip');
        assert.equal(Buffer.from(options.body).toString(), 'test package bytes');
        return Response.json({uploadState:scenario === 'success' ? 'SUCCESS' : 'IN_PROGRESS'});
      }
      if (url.endsWith(':fetchStatus')) {
        console.log('TEST_STATUS');
        return Response.json({uploadState:scenario === 'upload-failure' ? 'FAILURE' : scenario === 'upload-timeout' ? 'IN_PROGRESS' : 'SUCCESS'});
      }
      if (url.endsWith(':publish')) {
        console.log('TEST_PUBLISH');
        assert.equal(options.method, 'POST');
        if (scenario === 'publish-failure') return new Response(JSON.stringify({error:'private error body'}), {status:400});
        return Response.json({state:'PENDING_REVIEW'});
      }
      throw new Error('Unexpected URL');
    };
  `;
  const result = spawnSync(process.execPath, [
    '--import', 'data:text/javascript;base64,' + Buffer.from(preload).toString('base64'), script, zip,
  ], {
    encoding: 'utf8',
    env: { ...process.env, CWS_SERVICE_ACCOUNT_KEY: key, CWS_PUBLISHER_ID: 'test-publisher', CWS_EXTENSION_ID: 'a'.repeat(32), ...overrides },
  });
  assert.equal(result.error, undefined);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /DO_NOT_LOG|BEGIN PRIVATE KEY|private error body/);
  return { ...result, output };
}

test('uploads and submits a successful package', () => {
  const result = run('success');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /TEST_UPLOAD[\s\S]*TEST_PUBLISH[\s\S]*Submitted/);
});
test('waits for an in-progress upload before submitting', () => {
  const result = run('in-progress');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /TEST_UPLOAD[\s\S]*TEST_STATUS[\s\S]*TEST_PUBLISH/);
});
for (const scenario of ['token-failure', 'upload-failure', 'upload-timeout']) {
  test(scenario + ' prevents publication', () => {
    const result = run(scenario);
    assert.equal(result.status, 1, result.output);
    assert.doesNotMatch(result.output, /TEST_PUBLISH/);
    if (scenario === 'token-failure') assert.doesNotMatch(result.output, /TEST_UPLOAD/);
  });
}
test('a failed publish is reported as a failure', () => {
  const result = run('publish-failure');
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.output, /Submitted/);
});
test('missing configuration fails before an upload', () => {
  const result = run('success', { CWS_EXTENSION_ID: '' });
  assert.equal(result.status, 1);
  assert.match(result.output, /Missing CWS_EXTENSION_ID/);
  assert.doesNotMatch(result.output, /TEST_UPLOAD/);
});
test('malformed credentials do not leak JSON snippets', () => {
  const result = run('success', { CWS_SERVICE_ACCOUNT_KEY: '{"private_key":"DO_NOT_LOG_MALFORMED' });
  assert.equal(result.status, 1);
  assert.match(result.output, /not valid JSON/);
  assert.doesNotMatch(result.output, /TEST_UPLOAD/);
});

