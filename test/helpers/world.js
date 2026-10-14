// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake Syncthing (recorded
// answers, see fakeSyncthing.js) and a manual clock, with the integration
// wired on top through registerHandlers. The periodic timer is off unless
// asked: the tests drive the readings and the events themselves.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { folderIds, peerIds } from '../../src/devices.js';
import { API_KEY, BASE_URL, FakeSyncthing, fixture } from './fakeSyncthing.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

/** A manual clock, shared by the hub and the tests. */
export function createClock(start = Date.UTC(2026, 9, 14, 19, 40, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export const CONFIG = { url: BASE_URL, api_key: API_KEY, language: 'en' };

/** Let the event loop and the promises it started run to their end. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @param {object} [options]
 * @param {FakeSyncthing} [options.syncthing]
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers] the hub's own refresh timer (mock them first)
 * @param {boolean} [options.events] follow the event API
 */
export async function createWorld({
  clock = createClock(),
  syncthing = new FakeSyncthing(),
  config = CONFIG,
  devices = [],
  connect = true,
  timings = {},
  timers = false,
  events = true,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    request: syncthing.request,
    timers,
    events,
    timings: { eventRetryMs: [1, 1, 1], ...timings },
    now: clock.now,
  });
  const world = {
    gladys,
    fake: gladys.fake,
    syncthing,
    app,
    hub: app.hub,
    clock,
    /** External ids of a folder's device, by folder ID. */
    folder: (id) => folderIds(gladys, syncthing.myID, id),
    /** External ids of a remote device's device, by device ID. */
    peer: (id) => peerIds(gladys, syncthing.myID, id),
    /** The last state published on a feature (`text` for the text features). */
    last: (externalId) => gladys.fake.lastState(externalId),
    /** The scene events fired with a key. */
    sceneEvents: (key) => gladys.fake.sceneEvents.filter((event) => event.key === key),
    async stop() {
      await app.stop();
    },
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
    await settle();
  }
  return world;
}

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
  await settle();
}

export { API_KEY, BASE_URL, FakeSyncthing, fixture };
