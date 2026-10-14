import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { ACTIONS, MAX_ROWS, offlineText } from '../src/widgets.js';
import {
  CONFIG,
  FakeSyncthing,
  createClock,
  createWorld,
  fixture,
  settle,
} from './helpers/world.js';

const PHOTOS = 'photos-x7k2';

async function content(world, settings = {}, language = 'en') {
  const ack = await world.fake.widgetGet(WIDGET_KEY, { settings, language, units: 'metric' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(validateWidgetContent(ack.data.content), [], 'rendered exactly as sent');
  return ack.data.content;
}

const byType = (content, type) => content.components.filter((c) => c.type === type);

test('folders and devices with their state, the problems first', async (t) => {
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v1.30.0' }) });
  t.after(() => world.stop());
  world.syncthing.replay(fixture('v1.30.0/events-failed.json'));
  await settle();
  const widget = await content(world);
  const tiles = byType(widget, 'value');
  assert.deepEqual(
    tiles.map((tile) => [tile.label, tile.value, tile.unit]),
    [
      ['Folders up to date', '2/3', undefined],
      ['Devices connected', '1/1', undefined],
      ['Download', 0, 'kB/s'],
      ['Upload', 0, 'kB/s'],
    ],
  );
  assert.equal(tiles[0].color, 'danger', 'a folder in error');
  const [status] = byType(widget, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value]),
    [
      ['Photos', 'Error'],
      ['Default Folder', 'Up to date'],
      ['Documents', 'Up to date'],
      ['nas', 'Connected'],
    ],
  );
  assert.deepEqual(
    byType(widget, 'button').map((b) => b.action.key),
    [ACTIONS.RESCAN, ACTIONS.PAUSE],
  );
  assert.equal(widget.ttl_seconds, 60);
});

test('a sync in progress shows its percentage, and refreshes sooner', async (t) => {
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v1.30.0' }) });
  t.after(() => world.stop());
  const events = fixture('v1.30.0/events-sync.json');
  world.syncthing.replay(events.slice(0, events.findIndex((e) => e.id === 179) + 1));
  await settle();
  const widget = await content(world, { show: 'folders' }, 'fr');
  const [status] = byType(widget, 'status');
  assert.deepEqual(status.items[0], {
    label: 'Photos',
    value: 'Synchronisation · 71 %',
    icon: 'refresh-cw',
    color: 'info',
  });
  assert.equal(byType(widget, 'value').length, 1, 'folders only: no device tile');
  assert.equal(widget.ttl_seconds, 30);
});

test('a device offline for hours, then days', async (t) => {
  const clock = createClock(Date.parse('2026-10-14T19:32:46Z'));
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v2.1.6' }), clock });
  t.after(() => world.stop());
  world.syncthing.connections = fixture('v2.1.6/system-connections-disconnected.json');
  world.syncthing.deviceStats = fixture('v2.1.6/stats-device-disconnected.json');
  clock.advance(3 * 3_600_000);
  await world.hub.refresh();
  let widget = await content(world, { show: 'devices' });
  assert.deepEqual(byType(widget, 'status')[0].items, [
    { label: 'laptop', value: 'Offline for 3 h', icon: 'wifi-off', color: 'warning' },
  ]);
  assert.deepEqual(byType(widget, 'button'), [], 'no folder button on a devices-only widget');
  clock.advance(3 * 24 * 3_600_000);
  widget = await content(world, { show: 'devices' }, 'de');
  assert.equal(byType(widget, 'status')[0].items[0].value, 'Seit 3 T. offline');
  assert.equal(offlineText(47, 'es'), 'Desconectado hace 47 h');
});

test('more than ten rows: the last one counts the others', async (t) => {
  const syncthing = new FakeSyncthing({ version: 'v2.1.6' });
  for (let i = 1; i <= 12; i += 1) {
    const id = `extra-${i}`;
    syncthing.folders.push({
      ...syncthing.folders[0],
      id,
      label: `Extra ${String(i).padStart(2, '0')}`,
    });
    syncthing.summaries.set(id, fixture('v2.1.6/db-status-docs.json'));
  }
  const world = await createWorld({ syncthing });
  t.after(() => world.stop());
  const [status] = byType(await content(world), 'status');
  assert.equal(status.items.length, MAX_ROWS);
  assert.deepEqual(status.items.at(-1), {
    label: 'Others',
    value: '+6',
    icon: 'more-horizontal',
    color: 'neutral',
  });
});

test('the buttons rescan, pause and resume every folder', async (t) => {
  const world = await createWorld({
    syncthing: new FakeSyncthing({ version: 'v2.1.6' }),
    timings: { scanWaitMs: 20 },
  });
  t.after(() => world.stop());
  let ack = await world.fake.widgetAction(WIDGET_KEY, ACTIONS.PAUSE, {}, { settings: {} });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.fr, '2 dossier(s) en pause.');
  await settle();
  let widget = await content(world);
  assert.deepEqual(
    byType(widget, 'button').map((b) => [b.action.key, b.label]),
    [
      [ACTIONS.RESCAN, 'Rescan'],
      [ACTIONS.RESUME, 'Resume all'],
    ],
  );
  ack = await world.fake.widgetAction(WIDGET_KEY, ACTIONS.RESUME, {}, { settings: {} });
  assert.equal(ack.data.message.en, '2 folder(s) resumed.');
  ack = await world.fake.widgetAction(WIDGET_KEY, ACTIONS.RESCAN, {}, { settings: {} });
  assert.equal(ack.data.message.es, 'Análisis solicitado para 2 carpeta(s).');
  ack = await world.fake.widgetAction(WIDGET_KEY, 'explode', {}, { settings: {} });
  assert.equal(ack.success, false);
  widget = await content(world);
  assert.equal(new Set(byType(widget, 'button').map((b) => b.action.key)).size, 2);
});

test('not configured, unreachable, empty: one sentence', async (t) => {
  const unconfigured = await createWorld({ config: { language: 'en' } });
  t.after(() => unconfigured.stop());
  assert.match(byType(await content(unconfigured), 'text')[0].text, /address and the API key/);

  const syncthing = new FakeSyncthing();
  syncthing.setFailure('down');
  const down = await createWorld({ syncthing });
  t.after(() => down.stop());
  assert.match(byType(await content(down, {}, 'fr'), 'text')[0].text, /^Syncthing ne répond pas/);

  // Unreachable after a first reading: the last known rows, and why.
  const world = await createWorld({ syncthing: new FakeSyncthing() });
  t.after(() => world.stop());
  world.syncthing.setFailure('down');
  await world.hub.refresh();
  const stale = await content(world);
  assert.equal(byType(stale, 'text').length, 1);
  assert.equal(byType(stale, 'status').length, 1);
  assert.deepEqual(byType(stale, 'button'), []);

  const lonely = new FakeSyncthing();
  lonely.folders = [];
  lonely.devices = lonely.devices.filter((d) => d.deviceID === lonely.myID);
  const empty = await createWorld({ syncthing: lonely, config: { ...CONFIG } });
  t.after(() => empty.stop());
  assert.match(byType(await content(empty), 'text')[0].text, /^No folder and no remote device/);
});

test('the folder rows follow the widget, not the devices added to Gladys', async (t) => {
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v2.1.6' }) });
  t.after(() => world.stop());
  assert.equal(world.fake.devices.length, 0);
  const [status] = byType(await content(world), 'status');
  assert.ok(status.items.some((item) => item.label === 'Photos'));
  assert.ok(world.hub.folders.has(PHOTOS));
});
