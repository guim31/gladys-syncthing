// -----------------------------------------------------------------------------
// Against real Syncthing: two instances started here, linked, sharing a
// folder; the integration follows the first one through its real REST and
// event API, the fake Gladys of the SDK on the other side.
//
//   SYNCTHING_BIN=/path/to/syncthing [SYNCTHING_BIN_2=/path/to/other] npm run test:real
//
// Skipped by `npm test` (and in the CI): it needs the binaries and takes a
// minute. Nothing leaves the machine: both instances listen on 127.0.0.1,
// with discovery, relays and NAT traversal off.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { registerHandlers } from '../../src/app.js';
import { FOLDER_FEATURES, PEER_FEATURES, folderIds, peerIds } from '../../src/devices.js';
import { TRIGGERS, WIDGET_KEY } from '../../src/hub.js';

const BIN = process.env.SYNCTHING_BIN || 'syncthing';
const BIN_2 = process.env.SYNCTHING_BIN_2 || BIN;
const enabled = Boolean(process.env.SYNCTHING_REAL);
const skip = enabled
  ? false
  : 'set SYNCTHING_REAL=1 (npm run test:real) to run against real Syncthing';

process.env.LOG_LEVEL ??= 'silent';

const FOLDER = 'gladys-test';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(check, what, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await check();
      if (last) {
        return last;
      }
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${what} (${last?.message ?? last})`);
}

/** One Syncthing, in a temporary home, on free ports of 127.0.0.1. */
async function startSyncthing(bin, root, name) {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  const generated = spawnSync(bin, ['generate', `--home=${home}`], { encoding: 'utf8' });
  assert.equal(generated.status, 0, `${bin} generate: ${generated.stderr}`);
  const [gui, listen] = [await freePort(), await freePort()];
  const apiKey = randomBytes(16).toString('hex');
  const child = spawn(
    bin,
    [
      'serve',
      `--home=${home}`,
      `--gui-address=127.0.0.1:${gui}`,
      `--gui-apikey=${apiKey}`,
      '--no-browser',
      '--no-restart',
    ],
    { env: { ...process.env, STNOUPGRADE: '1', STNODEFAULTFOLDER: '1' }, stdio: 'ignore' },
  );
  const url = `http://127.0.0.1:${gui}`;
  const api = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  };
  const status = await waitFor(() => api('GET', '/rest/system/status'), `${name} to start`);
  // Nothing beyond 127.0.0.1.
  await api('PATCH', '/rest/config/options', {
    listenAddresses: [`tcp://127.0.0.1:${listen}`],
    globalAnnounceEnabled: false,
    localAnnounceEnabled: false,
    relaysEnabled: false,
    natEnabled: false,
    urAccepted: -1,
    crashReportingEnabled: false,
  });
  // Syncthing 1.x creates a "Default Folder" in a new home: not part of the test.
  const folders = await api('GET', '/rest/config/folders');
  for (const folder of folders.filter((f) => f.id === 'default')) {
    await api('DELETE', `/rest/config/folders/${folder.id}`);
  }
  const version = (await api('GET', '/rest/system/version')).version;
  return { name, home, url, apiKey, api, id: status.myID, listen, child, version };
}

test('the integration follows real Syncthing', { skip, timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gladys-syncthing-real-'));
  const instances = [];
  t.after(() => {
    for (const instance of instances) {
      instance.child.kill();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const a = await startSyncthing(BIN, root, 'nas');
  instances.push(a);
  const b = await startSyncthing(BIN_2, root, 'laptop');
  instances.push(b);
  t.diagnostic(`Syncthing ${a.version} (followed) and ${b.version}`);

  // Link them, and share one folder.
  await a.api('POST', '/rest/config/devices', {
    deviceID: b.id,
    name: 'laptop',
    addresses: [`tcp://127.0.0.1:${b.listen}`],
  });
  await b.api('POST', '/rest/config/devices', {
    deviceID: a.id,
    name: 'nas',
    addresses: [`tcp://127.0.0.1:${a.listen}`],
  });
  const pathA = join(root, 'nas-data');
  const pathB = join(root, 'laptop-data');
  for (const [instance, path] of [
    [a, pathA],
    [b, pathB],
  ]) {
    mkdirSync(path, { recursive: true });
    await instance.api('POST', '/rest/config/folders', {
      id: FOLDER,
      label: 'Photos',
      path,
      devices: [{ deviceID: a.id }, { deviceID: b.id }],
      fsWatcherEnabled: true,
      fsWatcherDelayS: 1,
      rescanIntervalS: 3600,
    });
  }
  await waitFor(
    async () => (await a.api('GET', '/rest/system/connections')).connections[b.id]?.connected,
    'the two instances to connect',
  );

  // The integration, on the first instance.
  const gladys = createFakeGladys({ config: { url: a.url, api_key: a.apiKey, language: 'en' } });
  const app = registerHandlers(gladys, {
    timers: false,
    timings: { eventRetryMs: [200, 500, 1000], reloadDebounceMs: 500, scanWaitMs: 5000 },
  });
  t.after(() => app.stop());
  await gladys.connect();
  await app.ready;
  const hub = app.hub;
  const folder = folderIds(gladys, a.id, FOLDER);
  const peer = peerIds(gladys, a.id, b.id);
  const last = (id) => gladys.fake.lastState(id);

  // Discovery: the folder and the other instance, not this one.
  await waitFor(() => gladys.fake.discoveredDevices.length >= 2, 'the discovery');
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id).sort(),
    [folder.device, peer.device].sort(),
  );
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
  await waitFor(() => last(folder.feature(FOLDER_FEATURES.STATE)) === 'Up to date', 'up to date');
  assert.equal(last(peer.feature(PEER_FEATURES.CONNECTED)), 1);

  // A file written on the other side arrives: "Folder synced", live.
  writeFileSync(join(pathB, 'hello.txt'), 'hello from the laptop\n');
  writeFileSync(join(pathB, 'big.bin'), randomBytes(5_000_000));
  await b.api('POST', `/rest/db/scan?folder=${FOLDER}`);
  const synced = await waitFor(
    () => gladys.fake.sceneEvents.find((e) => e.key === TRIGGERS.FOLDER_SYNCED),
    '"Folder synced"',
  );
  assert.equal(synced.data.folder, folder.device);
  assert.equal(synced.data.folder_name, 'Photos');
  assert.ok(synced.data.files >= 2, `files: ${synced.data.files}`);
  await hub.flushStates({ force: true });
  assert.match(last(folder.feature(FOLDER_FEATURES.LAST_FILE)), /^(hello\.txt|big\.bin)$/);
  assert.equal(last(folder.feature(FOLDER_FEATURES.COMPLETION)), 100);

  // The "Paused" switch pauses the folder in Syncthing, and resumes it.
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === folder.device);
  const pausedFeature = device.features.find((f) => f.external_id === folder.feature('paused'));
  assert.deepEqual(await gladys.fake.setValue(device, pausedFeature, 1), { success: true });
  assert.equal((await a.api('GET', `/rest/config/folders/${FOLDER}`)).paused, true);
  await waitFor(() => last(folder.feature(FOLDER_FEATURES.STATE)) === 'Paused', 'paused');
  await gladys.fake.setValue(device, pausedFeature, 0);
  assert.equal((await a.api('GET', `/rest/config/folders/${FOLDER}`)).paused, false);
  await waitFor(() => last(folder.feature(FOLDER_FEATURES.STATE)) === 'Up to date', 'resumed');

  // A folder whose marker disappeared stops on an error: "Sync error".
  renameSync(join(pathA, '.stfolder'), join(root, 'stfolder-away'));
  await a.api('POST', `/rest/db/scan?folder=${FOLDER}`).catch(() => {});
  const error = await waitFor(
    () => gladys.fake.sceneEvents.find((e) => e.key === TRIGGERS.SYNC_ERROR),
    '"Sync error"',
  );
  assert.match(error.data.message, /folder marker missing/);
  assert.equal(last(folder.feature(FOLDER_FEATURES.STATE)), 'Error');
  renameSync(join(root, 'stfolder-away'), join(pathA, '.stfolder'));
  await a.api('POST', `/rest/db/scan?folder=${FOLDER}`);
  await waitFor(() => last(folder.feature(FOLDER_FEATURES.STATE)) === 'Up to date', 'recovered');

  // The scene action and the widget.
  const scan = await gladys.fake.sceneAction('scan_folders', {});
  assert.deepEqual(scan, { success: true, data: { outputs: { count: 1 } } });
  await waitFor(() => hub.folders.get(FOLDER).state === 'idle', 'the scan to end');
  const widget = await gladys.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'fr' });
  assert.deepEqual(validateWidgetContent(widget.data.content), []);
  const status = widget.data.content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Photos', 'À jour'],
      ['laptop', 'Connecté'],
    ],
  );

  // The other instance goes away: disconnected, live.
  b.child.kill();
  await waitFor(() => last(peer.feature(PEER_FEATURES.CONNECTED)) === 0, 'disconnected');
  assert.equal(last(peer.feature(PEER_FEATURES.OFFLINE_HOURS)), 0);

  // The followed one goes away: the status says so.
  a.child.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await hub.refresh();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer/);
});
