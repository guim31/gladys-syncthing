import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSyncthing, createWorld, settle } from './helpers/world.js';

const PHOTOS = 'photos-x7k2';

const writes = (syncthing) =>
  syncthing.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]);

test('"Pause folders" pauses every folder, or the one chosen; "Resume folders" undoes it', async (t) => {
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v1.30.0' }) });
  t.after(() => world.stop());

  let ack = await world.fake.sceneAction('pause_folders', { folder: world.folder(PHOTOS).device });
  assert.deepEqual(ack, { success: true, data: { outputs: { count: 1 } } });
  ack = await world.fake.sceneAction('pause_folders', {});
  assert.deepEqual(ack.data.outputs, { count: 2 }, 'the two others');
  ack = await world.fake.sceneAction('pause_folders', {});
  assert.deepEqual(ack.data.outputs, { count: 0 }, 'already paused');
  ack = await world.fake.sceneAction('resume_folders', {});
  assert.deepEqual(ack.data.outputs, { count: 3 });
  await settle();
  assert.deepEqual(
    writes(world.syncthing).map(([method, path, body]) => `${method} ${path} ${body.paused}`),
    [
      `PATCH /rest/config/folders/${PHOTOS} true`,
      'PATCH /rest/config/folders/default true',
      'PATCH /rest/config/folders/docs true',
      'PATCH /rest/config/folders/default false',
      'PATCH /rest/config/folders/docs false',
      `PATCH /rest/config/folders/${PHOTOS} false`,
    ],
  );
});

test('"Rescan folders" asks Syncthing to scan, and leaves a long scan running', async (t) => {
  const world = await createWorld({
    syncthing: new FakeSyncthing({ version: 'v2.1.6' }),
    timings: { scanWaitMs: 20 },
  });
  t.after(() => world.stop());
  let ack = await world.fake.sceneAction('scan_folders', { folder: world.folder('docs').device });
  assert.deepEqual(ack.data.outputs, { count: 1 });
  ack = await world.fake.sceneAction('scan_folders', {});
  assert.deepEqual(ack.data.outputs, { count: 2 });
  assert.deepEqual(writes(world.syncthing), [
    ['POST', '/rest/db/scan?folder=docs', undefined],
    ['POST', '/rest/db/scan?folder=docs', undefined],
    ['POST', `/rest/db/scan?folder=${PHOTOS}`, undefined],
  ]);
  // Syncthing answers once the scan is over: a long one is left running.
  world.syncthing.scanHang = true;
  ack = await world.fake.sceneAction('scan_folders', {});
  assert.deepEqual(ack.data.outputs, { count: 2 });
});

test('the scene actions say why they cannot run', async (t) => {
  const world = await createWorld({ syncthing: new FakeSyncthing({ version: 'v2.1.6' }) });
  t.after(() => world.stop());
  const peer = world.peer(world.syncthing.remoteIds[0]).device;
  let ack = await world.fake.sceneAction('pause_folders', { folder: peer });
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'This device is not a Syncthing folder.');

  world.syncthing.setFailure('down');
  await world.hub.refresh();
  ack = await world.fake.sceneAction('scan_folders', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /^Syncthing does not answer/);

  const unconfigured = await createWorld({ config: { language: 'fr' } });
  t.after(() => unconfigured.stop());
  ack = await unconfigured.fake.sceneAction('resume_folders', {});
  assert.equal(ack.error, "Syncthing n'est pas configuré.");
});
