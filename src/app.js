// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the hub, so index.js stays a few lines and the tests drive the
// very same wiring. (Adapted from guim31/gladys-uptime-kuma.)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { SyncthingHub } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { INIT_FAILED } from './texts.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'syncthing-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: request, timers, events, timings, now
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new SyncthingHub({
    gladys,
    request: options.request,
    timers: options.timers ?? true,
    events: options.events ?? true,
    timings: options.timings,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // request arriving during the first reading is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): send again what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  // "Search" in the Discovery tab: read Syncthing, publish the list again.
  gladys.onScanRequest(whenReady(() => hub.fullReload({ publish: true })));

  // The devices are published with should_poll: false (the hub follows
  // Syncthing on its own); this only serves a Gladys that would poll anyway.
  gladys.onPoll(whenReady((device) => hub.pollDevice(device)));

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));
  gladys.onDeviceUpdated(whenReady((device) => hub.onDeviceCreated(device)));

  // The only writable features: the "Paused" switches.
  gladys.onSetValue(
    whenReady(async (device, feature, value) => {
      if (!feature.external_id.endsWith(':paused')) {
        throw new Error(`${feature.external_id} is read only`);
      }
      await hub.setPaused(device.external_id, Number(value) === 1);
    }),
  );

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      logger.info('New configuration received');
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'test_connection',
    whenReady(() => hub.testConnection()),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady(async (actionKey, params, context = {}) => {
        logger.info(`Widget button: ${actionKey}`);
        return widget.action(hub, { actionKey, params, ...context });
      }),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
