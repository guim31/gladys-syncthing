// -----------------------------------------------------------------------------
// The hub against the recorded Syncthing: discovery, states, the real event
// sequences (a sync, a failed item and its retry, a folder error, pauses, a
// device going away), the refresh of its own, the logs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLDER_FEATURES, PEER_FEATURES } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import {
  API_KEY,
  CONFIG,
  FakeSyncthing,
  createClock,
  createDevices,
  createWorld,
  fixture,
  settle,
} from './helpers/world.js';

const PHOTOS = 'photos-x7k2';
const HOUR = 3_600_000;

/** A world on the recorded Syncthing 1.30.0 ("laptop"), every device added. */
async function laptop(options = {}) {
  const world = await createWorld({
    syncthing: new FakeSyncthing({ version: 'v1.30.0' }),
    ...options,
  });
  await createDevices(world);
  return world;
}

/** A world on the recorded Syncthing 2.1.6 ("nas"), every device added. */
async function nas(options = {}) {
  const world = await createWorld({
    syncthing: new FakeSyncthing({ version: 'v2.1.6' }),
    ...options,
  });
  await createDevices(world);
  return world;
}

/** Capture the log lines (console), at the level asked. */
function captureLogs(t, level) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.map(String).join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

/** The successive values published on a feature. */
const history = (world, externalId) =>
  world.fake.states
    .filter((state) => state.device_feature_external_id === externalId)
    .map((state) => state.text ?? state.state);

test('one device per folder and per remote device, never this Syncthing itself', async (t) => {
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v1.30.0' }) });
  t.after(() => world.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => [d.name, d.external_id]),
    [
      ['Default Folder', world.folder('default').device],
      ['Documents', world.folder('docs').device],
      ['Photos', world.folder(PHOTOS).device],
      ['nas', world.peer(world.syncthing.remoteIds[0]).device],
    ],
  );
  assert.match(world.folder(PHOTOS).device, /^ext:test-integration:folder:MFZWI3D-photos-x7k2$/);
  assert.match(world.peer(world.syncthing.remoteIds[0]).device, /:device:MFZWI3D-P56IOI7$/);
  const photos = devices.find((d) => d.name === 'Photos');
  assert.deepEqual(photos.params, [
    { name: 'SYNCTHING_FOLDER_ID', value: PHOTOS },
    { name: 'SYNCTHING_FOLDER_TYPE', value: 'sendreceive' },
  ]);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('states go to the devices added to Gladys only, all of them once added', async (t) => {
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v2.1.6' }) });
  t.after(() => world.stop());
  assert.equal(world.fake.states.length, 0, 'nothing added yet');

  await createDevices(world, (device) => device.name === 'Photos');
  const ids = world.folder(PHOTOS);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Up to date');
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.UP_TO_DATE)), 1);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.COMPLETION)), 100);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.REMAINING)), 0);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.ERRORS)), 0);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.PAUSED)), 0);
  // The last file Syncthing received, from /rest/stats/folder.
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.LAST_FILE)), 'from-b.txt');
  assert.ok(
    world.fake.states.every((s) => s.device_feature_external_id.startsWith(ids.device)),
    'only the added folder',
  );
  assert.deepEqual(world.fake.transports.at(-1), {
    device_external_id: ids.device,
    transport: 'local',
  });
  assert.ok(world.fake.widgetRefreshes.length > 0, 'the widget is told');

  await createDevices(world, (device) => device.name === 'laptop');
  const peer = world.peer(world.syncthing.remoteIds[0]);
  assert.equal(world.last(peer.feature(PEER_FEATURES.CONNECTED)), 1);
  assert.equal(world.last(peer.feature(PEER_FEATURES.PAUSED)), 0);
  assert.equal(world.last(peer.feature(PEER_FEATURES.OFFLINE_HOURS)), 0);
});

test('a real sync, live: syncing, the progress, then "Folder synced" once', async (t) => {
  const clock = createClock();
  const world = await laptop({ clock });
  t.after(() => world.stop());
  const ids = world.folder(PHOTOS);
  const events = fixture('v1.30.0/events-sync.json');
  const at = (id) => events.findIndex((e) => e.id === id);
  clock.advance(60_000);

  // Up to the first summary: 71 % received.
  world.syncthing.replay(events.slice(0, at(179) + 1));
  await settle();
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Syncing');
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.UP_TO_DATE)), 0);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.COMPLETION)), 71);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.REMAINING)), 26.2);

  // Two more summaries within 30 s: held back (the 300 states a minute of Gladys).
  clock.advance(10_000);
  world.syncthing.replay(events.slice(at(179) + 1, at(186) + 1));
  await settle();
  assert.deepEqual(history(world, ids.feature(FOLDER_FEATURES.COMPLETION)), [100, 71]);

  // The end: everything received.
  clock.advance(5_000);
  world.syncthing.replay(events.slice(at(186) + 1));
  await settle();
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Up to date');
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.UP_TO_DATE)), 1);
  assert.deepEqual(world.sceneEvents(TRIGGERS.FOLDER_SYNCED), [
    {
      key: TRIGGERS.FOLDER_SYNCED,
      data: { folder: ids.device, folder_name: 'Photos', files: 1 },
    },
  ]);
  // The last value of a held feature is sent once its window is over.
  clock.advance(30_000);
  await world.hub.flushStates();
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.COMPLETION)), 100);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.LAST_FILE)), '2026/vacances/VID_0001.mp4');
});

test('scans and index updates never fire "Folder synced"', async (t) => {
  const world = await laptop();
  t.after(() => world.stop());
  const folder = PHOTOS;
  world.syncthing.emit(
    { type: 'StateChanged', data: { folder, from: 'idle', to: 'scan-waiting' } },
    { type: 'StateChanged', data: { folder, from: 'scan-waiting', to: 'scanning' } },
    { type: 'StateChanged', data: { folder, from: 'scanning', to: 'idle' } },
    { type: 'StateChanged', data: { folder, from: 'idle', to: 'sync-preparing' } },
    { type: 'StateChanged', data: { folder, from: 'sync-preparing', to: 'idle' } },
  );
  await settle();
  world.syncthing.emit({
    type: 'FolderSummary',
    data: { folder, summary: world.syncthing.summaries.get(folder) },
  });
  await settle();
  assert.deepEqual(world.fake.sceneEvents, []);
});

test('a failed item fires "Sync error" once with its message; the retry that fixes it, "Folder synced"', async (t) => {
  const world = await laptop();
  t.after(() => world.stop());
  const ids = world.folder(PHOTOS);

  world.syncthing.replay(fixture('v1.30.0/events-failed.json'));
  await settle();
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Error');
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.ERRORS)), 1);
  const [error] = world.sceneEvents(TRIGGERS.SYNC_ERROR);
  assert.equal(error.data.folder, ids.device);
  assert.equal(error.data.folder_name, 'Photos');
  assert.equal(error.data.errors, 1);
  assert.match(error.data.message, /^2026\/IMG_0100\.jpg: .*operation not permitted$/);
  assert.equal(world.sceneEvents(TRIGGERS.FOLDER_SYNCED).length, 0, 'nothing was received');

  // Syncthing retries a minute later (scans, a sync that fails again…).
  world.syncthing.emit(
    { type: 'StateChanged', data: { folder: PHOTOS, from: 'idle', to: 'sync-preparing' } },
    { type: 'StateChanged', data: { folder: PHOTOS, from: 'sync-preparing', to: 'idle' } },
  );
  await settle();
  assert.equal(world.sceneEvents(TRIGGERS.SYNC_ERROR).length, 1, 'said once while it lasts');

  // The retry that works (recorded once the directory was writable again).
  world.syncthing.replay(fixture('v1.30.0/events-recovered.json'));
  await settle();
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.ERRORS)), 0);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Up to date');
  assert.equal(world.sceneEvents(TRIGGERS.SYNC_ERROR).length, 1);
  assert.deepEqual(
    world.sceneEvents(TRIGGERS.FOLDER_SYNCED).map((e) => e.data),
    [{ folder: ids.device, folder_name: 'Photos', files: 1 }],
  );
});

test('a folder stopped on an error fires "Sync error" with the reason of Syncthing', async (t) => {
  const world = await laptop();
  t.after(() => world.stop());
  world.syncthing.replay(fixture('v1.30.0/events-folder-error.json').slice(0, 1));
  await settle();
  const ids = world.folder('docs');
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Error');
  const [error] = world.sceneEvents(TRIGGERS.SYNC_ERROR);
  assert.equal(error.data.folder_name, 'Documents');
  assert.equal(error.data.errors, 1);
  assert.match(error.data.message, /^folder marker missing/);
  // The marker back: the folder scans and is up to date again.
  world.syncthing.replay(fixture('v1.30.0/events-folder-error.json').slice(1));
  await settle();
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Up to date');
  assert.equal(world.sceneEvents(TRIGGERS.SYNC_ERROR).length, 1);
});

test('the first reading sets the baseline: a folder already failing fires nothing', async (t) => {
  const syncthing = new FakeSyncthing({ version: 'v1.30.0' });
  syncthing.setSummary(PHOTOS, fixture('v1.30.0/db-status-failed.json'));
  syncthing.folderErrors.set(PHOTOS, fixture('v1.30.0/folder-errors.json').errors);
  const world = await createWorld({ syncthing });
  t.after(() => world.stop());
  await createDevices(world);
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.equal(world.last(world.folder(PHOTOS).feature(FOLDER_FEATURES.ERRORS)), 1);
  assert.equal(world.hub.folders.get(PHOTOS).errorList.length, 1, 'the list is read for later');
});

test('the "Paused" switches pause and resume a folder and a device', async (t) => {
  const world = await nas();
  t.after(() => world.stop());
  const folderDevice = world.fake.discoveredDevices.find((d) => d.name === 'Photos');
  const pausedFeature = folderDevice.features.find((f) => f.external_id.endsWith(':paused'));
  assert.equal(pausedFeature.read_only, false);

  assert.deepEqual(await world.fake.setValue(folderDevice, pausedFeature, 1), { success: true });
  await settle();
  assert.deepEqual(world.syncthing.callsTo(`/rest/config/folders/${PHOTOS}`).at(-1).body, {
    paused: true,
  });
  const ids = world.folder(PHOTOS);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.PAUSED)), 1);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Paused');

  assert.deepEqual(await world.fake.setValue(folderDevice, pausedFeature, 0), { success: true });
  await settle();
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.PAUSED)), 0);

  const remote = world.syncthing.remoteIds[0];
  const peerDevice = world.fake.discoveredDevices.find((d) => d.name === 'laptop');
  const peerPaused = peerDevice.features.find((f) => f.external_id.endsWith(':paused'));
  await world.fake.setValue(peerDevice, peerPaused, 1);
  await settle();
  const peer = world.peer(remote);
  assert.equal(world.last(peer.feature(PEER_FEATURES.PAUSED)), 1);
  assert.equal(world.last(peer.feature(PEER_FEATURES.CONNECTED)), 0);

  // A read-only feature refuses.
  const state = folderDevice.features.find((f) => f.external_id.endsWith(':state'));
  assert.equal((await world.fake.setValue(folderDevice, state, 1)).success, false);
});

test('the pause events of Syncthing 2.1.6 are followed', async (t) => {
  const world = await nas();
  t.after(() => world.stop());
  const events = fixture('v2.1.6/events-pause.json');
  world.syncthing.replay(events.slice(0, 1)); // FolderPaused
  await settle();
  const ids = world.folder(PHOTOS);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.PAUSED)), 1);
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.STATE)), 'Paused');
  // One event at a time, as they came (two seconds apart).
  for (const event of events.slice(1)) {
    world.syncthing.replay([event]);
    await settle();
  }
  assert.equal(world.last(ids.feature(FOLDER_FEATURES.PAUSED)), 0);
  const peer = world.peer(world.syncthing.remoteIds[0]);
  assert.deepEqual(history(world, peer.feature(PEER_FEATURES.PAUSED)), [0, 1, 0]);
  assert.equal(world.last(peer.feature(PEER_FEATURES.CONNECTED)), 1);
});

test('a device that goes away: disconnected, then the hours offline', async (t) => {
  const clock = createClock(Date.parse('2026-10-14T19:32:46Z'));
  const world = await nas({ clock });
  t.after(() => world.stop());
  const peer = world.peer(world.syncthing.remoteIds[0]);
  const [disconnected] = fixture('v2.1.6/events-device-restart.json');
  assert.equal(disconnected.type, 'DeviceDisconnected');
  world.syncthing.connections = fixture('v2.1.6/system-connections-disconnected.json');
  world.syncthing.deviceStats = fixture('v2.1.6/stats-device-disconnected.json');
  world.syncthing.replay([disconnected]);
  await settle();
  assert.equal(world.last(peer.feature(PEER_FEATURES.CONNECTED)), 0);
  assert.equal(world.last(peer.feature(PEER_FEATURES.OFFLINE_HOURS)), 0);
  assert.equal(world.last(peer.feature(PEER_FEATURES.DOWNLOAD)), 0);

  clock.advance(5 * HOUR + 60_000);
  await world.hub.refresh();
  assert.equal(world.last(peer.feature(PEER_FEATURES.OFFLINE_HOURS)), 5);
  clock.advance(HOUR);
  await world.hub.refresh();
  assert.deepEqual(history(world, peer.feature(PEER_FEATURES.OFFLINE_HOURS)), [0, 5, 6]);
});

test('download and upload rates come from two readings of the connections', async (t) => {
  const syncthing = new FakeSyncthing({ version: 'v2.1.6' });
  syncthing.connections = fixture('v2.1.6/system-connections-1.json');
  const world = await createWorld({ syncthing });
  t.after(() => world.stop());
  await createDevices(world);
  const peer = world.peer(syncthing.remoteIds[0]);
  assert.equal(world.last(peer.feature(PEER_FEATURES.DOWNLOAD)), undefined, 'one reading: no rate');
  // Ten seconds later (recorded): 9 674 bytes in, 9 291 689 bytes out.
  syncthing.connections = fixture('v2.1.6/system-connections-2.json');
  await world.hub.refresh();
  assert.equal(world.last(peer.feature(PEER_FEATURES.DOWNLOAD)), 1);
  assert.equal(world.last(peer.feature(PEER_FEATURES.UPLOAD)), 929.2);
});

test('the container refreshes the states by itself, without any onPoll (Gladys#3198)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-14T19:30:19Z') });
  const syncthing = new FakeSyncthing({ version: 'v2.1.6' });
  syncthing.connections = fixture('v2.1.6/system-connections-1.json');
  const world = await createWorld({ syncthing, clock: { now: () => Date.now() }, timers: true });
  t.after(() => world.stop());
  await createDevices(world);
  const peer = world.peer(syncthing.remoteIds[0]);
  const reads = () => syncthing.callsTo('/rest/system/connections').length;
  const before = reads();

  syncthing.connections = fixture('v2.1.6/system-connections-2.json');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(reads(), before + 1, 'read again after 30 s, no onPoll from the core');
  assert.equal(world.last(peer.feature(PEER_FEATURES.UPLOAD)), 929.2);

  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(reads(), before + 2);
  // Every five minutes, the folders too (the safety net of the event API).
  const folderReads = () => syncthing.callsTo('/rest/db/status').length;
  const foldersBefore = folderReads();
  for (let i = 0; i < 10; i += 1) {
    t.mock.timers.tick(30_000);
    await settle();
  }
  assert.equal(folderReads(), foldersBefore + 2, 'one full reading: two folders');
});

test('unchanged values are sent again once per heartbeat (no "no recent value")', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-14T20:00:00Z') });
  const world = await createWorld({
    syncthing: new FakeSyncthing({ version: 'v2.1.6' }),
    clock: { now: () => Date.now() },
    timers: true,
    timings: { refreshMs: HOUR, fullReloadMs: 24 * HOUR },
  });
  t.after(() => world.stop());
  await createDevices(world);
  const state = world.folder(PHOTOS).feature(FOLDER_FEATURES.STATE);
  assert.equal(history(world, state).length, 1);
  for (let i = 0; i < 11; i += 1) {
    t.mock.timers.tick(HOUR);
    await settle();
  }
  assert.equal(history(world, state).length, 1, 'nothing changed in 11 h');
  t.mock.timers.tick(HOUR);
  await settle();
  assert.equal(history(world, state).length, 2, 'sent again after 12 h');
});

test('Syncthing unreachable: the status says why, once; its return, one line', async (t) => {
  const lines = captureLogs(t, 'info');
  const world = await nas();
  t.after(() => world.stop());
  lines.length = 0;
  const ids = world.folder(PHOTOS);

  world.syncthing.setFailure('down');
  await settle();
  await world.hub.refresh();
  await world.hub.refresh();
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /does not answer.*0\.0\.0\.0:8384/);
  assert.equal(
    world.fake.transports.findLast((entry) => entry.device_external_id === ids.device).transport,
    'unreachable',
  );
  const warnings = lines.filter((l) => l.includes('[WARN]'));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /Syncthing at 192\.0\.2\.10:8384: ECONNREFUSED/);

  world.syncthing.setFailure(null);
  await world.hub.refresh();
  await settle();
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.fake.transports.at(-1).transport, 'local');
  const infos = lines.filter((l) => l.includes('[INFO]'));
  assert.equal(infos.length, 1, infos.join('\n'));
  assert.match(infos[0], /Syncthing answers again: v2\.1\.6 \(P56IOI7\), 2 folder\(s\)/);
});

test('a wrong API key: the status says so', async (t) => {
  const syncthing = new FakeSyncthing();
  const world = await createWorld({ syncthing, config: { ...CONFIG, api_key: 'wrong' } });
  t.after(() => world.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /^Clé d'API refusée/);
  assert.deepEqual(world.fake.discoveredDevices, []);
});

test('not configured yet: the status asks for the address and the key', async (t) => {
  const world = await createWorld({ config: { language: 'en' } });
  t.after(() => world.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /address and the API key/);
  assert.equal(world.syncthing.calls.length, 0);
  const invalid = await createWorld({ config: { url: 'ftp://nas', api_key: API_KEY } });
  t.after(() => invalid.stop());
  assert.match(invalid.fake.connectionStatus.message.en, /^Address not understood/);
});

test('the event API unavailable: read every 30 s instead, said once', async (t) => {
  const lines = captureLogs(t, 'info');
  const syncthing = new FakeSyncthing();
  syncthing.eventsFailure = { status: 500, body: 'events disabled' };
  const world = await createWorld({ syncthing });
  t.after(() => world.stop());
  await settle();
  assert.equal(world.hub.eventsHealthy, false);
  const reads = () => syncthing.callsTo('/rest/config/folders').length;
  const before = reads();
  await world.hub.refresh();
  await world.hub.refresh();
  assert.equal(reads(), before + 2, 'a full reading at every refresh');
  const warnings = lines.filter((l) => l.includes('[WARN]'));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /event stream unavailable: HTTP 500/);
  const report = await world.fake.action('test_connection', {});
  assert.match(report.data.message.en, /live updates unavailable/);
});

test('events missed by a slow reader: Syncthing is read again', async (t) => {
  const world = await nas();
  t.after(() => world.stop());
  const reads = () => world.syncthing.callsTo('/rest/config/folders').length;
  const before = reads();
  world.syncthing.skip(5);
  world.syncthing.emit({
    type: 'StateChanged',
    data: { folder: 'docs', from: 'idle', to: 'scanning' },
  });
  await settle();
  assert.equal(reads(), before + 1);
});

test('Syncthing restarted: the integration follows its new events', async (t) => {
  const world = await nas();
  t.after(() => world.stop());
  world.syncthing.emit({
    type: 'StateChanged',
    data: { folder: 'docs', from: 'idle', to: 'scanning' },
  });
  await settle();
  world.syncthing.restart();
  await new Promise((resolve) => setTimeout(resolve, 10)); // the retry delay of the test world
  await settle();
  world.syncthing.emit({ type: 'FolderPaused', data: { id: PHOTOS, label: 'Photos' } });
  await settle();
  assert.equal(world.last(world.folder(PHOTOS).feature(FOLDER_FEATURES.PAUSED)), 1);
});

test('a folder added in Syncthing is proposed after one reading', async (t) => {
  const world = await nas({ timings: { reloadDebounceMs: 5 } });
  t.after(() => world.stop());
  world.syncthing.folders.push({ ...world.syncthing.folders[0], id: 'music', label: 'Music' });
  world.syncthing.summaries.set('music', fixture('v2.1.6/db-status-docs.json'));
  world.syncthing.emit({ type: 'ConfigSaved', data: { version: 52 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  assert.ok(world.fake.discoveredDevices.some((d) => d.name === 'Music'));
});

test('a normal cycle writes nothing at info level', async (t) => {
  const clock = createClock();
  const world = await laptop({ clock });
  t.after(() => world.stop());
  const lines = captureLogs(t, 'info');
  world.syncthing.replay(fixture('v1.30.0/events-sync.json'));
  await settle();
  clock.advance(30_000);
  await world.hub.refresh();
  await world.hub.flushStates();
  await world.fake.widgetGet('syncthing', { settings: {}, language: 'en' });
  assert.deepEqual(lines, [], 'no line at info level or above');
});

test('no secret reaches the logs, not even at debug level', async (t) => {
  const lines = captureLogs(t, 'debug');
  const world = await nas({ timings: { reloadDebounceMs: 5 } });
  t.after(() => world.stop());
  // ConfigSaved carries the whole configuration of Syncthing, its API key included.
  world.syncthing.emit({
    type: 'ConfigSaved',
    data: { version: 52, gui: { apiKey: API_KEY, password: 'hunter2' } },
  });
  world.syncthing.replay(fixture('v1.30.0/events-failed.json'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  world.syncthing.apiKey = 'rotated';
  await world.hub.refresh();
  await world.fake.configUpdated({ ...CONFIG, api_key: 'another-secret-key' });
  await settle();
  assert.ok(lines.length > 5, 'debug lines were written');
  for (const secret of [API_KEY, 'hunter2', 'another-secret-key']) {
    assert.deepEqual(
      lines.filter((line) => line.includes(secret)),
      [],
      `${secret} in the logs`,
    );
  }
});

test('a new configuration: another address, or the language of the names', async (t) => {
  const world = await nas();
  t.after(() => world.stop());
  await world.fake.configUpdated({ ...CONFIG, language: 'fr' });
  await settle();
  const photos = world.fake.discoveredDevices.find((d) => d.name === 'Photos');
  assert.equal(photos.features[0].name, 'État');
  assert.equal(world.last(world.folder(PHOTOS).feature(FOLDER_FEATURES.STATE)), 'À jour');

  // Another Syncthing (here: the same, unreachable at another address).
  await world.fake.configUpdated({ ...CONFIG, url: 'http://192.0.2.99:8384', api_key: 'k' });
  await settle();
  assert.equal(world.fake.connectionStatus.connected, false);
});

test('onPoll, should the core ever call it, reads Syncthing again', async (t) => {
  const world = await nas();
  t.after(() => world.stop());
  const [device] = world.fake.discoveredDevices;
  assert.equal(device.should_poll, false);
  const before = world.syncthing.callsTo('/rest/system/connections').length;
  assert.deepEqual(await world.fake.poll(device), { success: true });
  assert.equal(world.syncthing.callsTo('/rest/system/connections').length, before + 1);
});
