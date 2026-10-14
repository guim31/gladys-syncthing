// The REST client against the recorded answers, and the errors as Syncthing
// really answers them (403 "CSRF Error", 403 "Host check error", HTML…).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ERROR_KINDS, EVENT_TYPES, SyncthingClient } from '../src/syncthing/client.js';
import { httpRequest } from '../src/syncthing/http.js';
import { API_KEY, BASE_URL, FakeSyncthing } from './helpers/fakeSyncthing.js';

const client = (syncthing, options = {}) =>
  new SyncthingClient({ url: BASE_URL, apiKey: API_KEY, request: syncthing.request, ...options });

/** A request seam answering one canned response. */
const answering = (response, calls = []) => ({
  request: async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) {
      throw response;
    }
    return { headers: {}, ...response };
  },
});

test('reads Syncthing with the API key header', async () => {
  const syncthing = new FakeSyncthing();
  const api = client(syncthing);
  const status = await api.status();
  assert.equal(status.myID, syncthing.myID);
  assert.equal((await api.version()).version, 'v2.1.6');
  assert.deepEqual(
    (await api.folders()).map((f) => f.id),
    ['docs', 'photos-x7k2'],
  );
  assert.equal((await api.folderStatus('photos-x7k2')).state, 'idle');
  assert.deepEqual(await api.folderErrors('photos-x7k2'), []);
});

test('the events are asked with the same list of types every time', async () => {
  const syncthing = new FakeSyncthing();
  const api = client(syncthing);
  assert.equal(await api.latestEventId(), 0);
  syncthing.emit({ type: 'StateChanged', data: { folder: 'docs', from: 'idle', to: 'scanning' } });
  assert.equal(await api.latestEventId(), 1);
  const polling = api.events(0);
  assert.deepEqual(
    (await polling).map((e) => e.type),
    ['StateChanged'],
  );
  const queries = syncthing.callsTo('/rest/events').map((c) => new URL(`http://x${c.path}`));
  assert.ok(queries.every((q) => q.searchParams.get('events') === EVENT_TYPES.join(',')));
  assert.equal(queries.at(-1).searchParams.get('timeout'), '60');
});

test('a long poll waits for an event, and can be cancelled', async () => {
  const syncthing = new FakeSyncthing();
  const api = client(syncthing);
  const controller = new AbortController();
  const polling = api.events(0, { signal: controller.signal });
  let done = false;
  polling.then(() => (done = true)).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, 'held until something happens');
  controller.abort();
  await assert.rejects(polling, { name: 'AbortError' });
});

test('writes pause, resume and rescan, nothing else', async () => {
  const syncthing = new FakeSyncthing();
  const api = client(syncthing);
  await api.setFolderPaused('photos-x7k2', true);
  await api.setDevicePaused(syncthing.remoteIds[0], true);
  await api.scan('docs');
  assert.deepEqual(
    syncthing.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]),
    [
      ['PATCH', '/rest/config/folders/photos-x7k2', { paused: true }],
      ['PATCH', `/rest/config/devices/${syncthing.remoteIds[0]}`, { paused: true }],
      ['POST', '/rest/db/scan?folder=docs', undefined],
    ],
  );
});

test('every failure has a kind, and no message carries the key', async () => {
  const cases = [
    [{ status: 403, body: 'CSRF Error\n' }, ERROR_KINDS.AUTH],
    [{ status: 401, body: 'Not Authorized' }, ERROR_KINDS.AUTH],
    [{ status: 403, body: 'Host check error\n' }, ERROR_KINDS.HOST_CHECK],
    [{ status: 307, body: '', headers: { location: 'https://x' } }, ERROR_KINDS.REDIRECT],
    [{ status: 200, body: '<!DOCTYPE html><html>' }, ERROR_KINDS.NOT_SYNCTHING],
    [{ status: 200, body: '{"hello":"world"}' }, ERROR_KINDS.NOT_SYNCTHING],
    [{ status: 404, body: '404 page not found' }, ERROR_KINDS.NOT_SYNCTHING],
    [{ status: 500, body: 'oops' }, ERROR_KINDS.HTTP],
    [Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), ERROR_KINDS.UNREACHABLE],
    [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), ERROR_KINDS.UNREACHABLE],
    [Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), ERROR_KINDS.TLS],
  ];
  for (const [response, kind] of cases) {
    const api = new SyncthingClient({ url: BASE_URL, apiKey: API_KEY, ...answering(response) });
    const error = await api.status().catch((err) => err);
    assert.equal(error.kind, kind, JSON.stringify(response.body ?? response.code));
    assert.ok(!error.message.includes(API_KEY));
  }
  // A missing folder is an HTTP error, not "no Syncthing".
  const api = client(new FakeSyncthing());
  assert.equal((await api.folderStatus('nope').catch((err) => err)).kind, ERROR_KINDS.HTTP);
  // A wrong key, as Syncthing answers it.
  const wrong = new SyncthingClient({
    url: BASE_URL,
    apiKey: 'wrong',
    request: new FakeSyncthing().request,
  });
  assert.equal((await wrong.status().catch((err) => err)).kind, ERROR_KINDS.AUTH);
});

test('a self-signed certificate is accepted only with the option', async () => {
  const calls = [];
  const strict = new SyncthingClient({
    url: 'https://192.0.2.10:8384',
    apiKey: API_KEY,
    ...answering({ status: 200, body: '{"myID":"X"}' }, calls),
  });
  await strict.status();
  const relaxed = new SyncthingClient({
    url: 'https://192.0.2.10:8384',
    apiKey: API_KEY,
    insecure: true,
    ...answering({ status: 200, body: '{"myID":"X"}' }, calls),
  });
  await relaxed.status();
  assert.deepEqual(
    calls.map((c) => c.options.insecure),
    [false, true],
  );
});

test('httpRequest sends the method, headers and body, and reads the answer', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      if (req.url === '/slow') {
        return; // never answers
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const answer = await httpRequest(`${base}/rest/config/folders/x`, {
    method: 'PATCH',
    headers: { 'x-api-key': 'k' },
    body: '{"paused":true}',
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '{"ok":true}');
  assert.deepEqual(seen[0], {
    method: 'PATCH',
    url: '/rest/config/folders/x',
    key: 'k',
    body: '{"paused":true}',
  });
  const controller = new AbortController();
  const slow = httpRequest(`${base}/slow`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(slow, { name: 'AbortError' });
  await assert.rejects(httpRequest(`${base}/slow`, { timeoutMs: 30 }), { code: 'ETIMEDOUT' });
  server.closeAllConnections();
});
