// Chrome Web Store API v2. Credentials stay in process memory.
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Missing ' + name);
  return value;
}

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
  let result;
  try { result = await response.json(); } catch { throw new Error('Non-JSON API response: ' + response.status); }
  // Never print response bodies: token responses contain credentials.
  if (!response.ok) throw new Error('API request failed: HTTP ' + response.status);
  if (result.error) throw new Error('API returned an error');
  return result;
}

async function main() {
  const publisher = required('CWS_PUBLISHER_ID');
  const extension = required('CWS_EXTENSION_ID');
  if (!/^[a-p]{32}$/.test(extension)) throw new Error('Invalid CWS_EXTENSION_ID');
  if (!/^[a-zA-Z0-9_-]+$/.test(publisher)) throw new Error('Invalid CWS_PUBLISHER_ID');
  const key = required('CWS_SERVICE_ACCOUNT_KEY');
  let credentials;
  try { credentials = JSON.parse(key); } catch { throw new Error('CWS_SERVICE_ACCOUNT_KEY is not valid JSON'); }
  if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) {
    throw new Error('CWS_SERVICE_ACCOUNT_KEY must be a service account JSON key');
  }
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/publish.mjs path/to/extension.zip');
  const zip = await readFile(file);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode(claims);
  const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key, 'base64url');
  const token = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature,
    }),
  });
  if (!token.access_token) throw new Error('No access token returned');
  const headers = { Authorization: 'Bearer ' + token.access_token };
  const item = 'publishers/' + publisher + '/items/' + extension;
  const api = 'https://chromewebstore.googleapis.com/v2/' + item;
  const upload = await request('https://chromewebstore.googleapis.com/upload/v2/' + item + ':upload', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: zip,
  });
  let state = upload.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 24; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await request(api + ':fetchStatus', { headers });
    state = status.uploadState;
  }
  if (state !== 'SUCCESS') throw new Error('Upload did not finish successfully: ' + String(state));
  await request(api + ':publish', { method: 'POST', headers });
  console.log('Submitted to Chrome Web Store for review. Approval is required before users receive the update.');
}

main().catch((error) => {
  // Do not print stacks, credentials, JWTs, or API response bodies.
  console.error(error.message);
  process.exitCode = 1;
});

