// -----------------------------------------------------------------------------
// The Syncthing hub: what Gladys knows of the configured Syncthing, kept up to
// date by three paths, and published to Gladys when it changes.
//
//   - the event API (`/rest/events`, long poll): folder states and summaries,
//     files synced, failed items, pauses, devices connecting — in real time;
//   - a timer of the container, every 30 s: connections (download and upload
//     rates, which no event carries) and the last time each device was seen;
//   - a full reload (configuration, summary of every folder) at start, when
//     the configuration of Syncthing changes, and every 5 minutes as a safety
//     net — every 30 s while the event API is unavailable.
//
// Gladys never polls these devices (should_poll: false, GladysAssistant/
// Gladys#3198); its onPoll, if it ever comes, reads Syncthing again.
//
// The scene triggers fire on transitions, for every folder, added to Gladys or
// not: "a folder finished syncing", "a sync error". Nothing is persisted: the
// first reading only sets the baseline, it never fires.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { hostOf, isConfigured } from './config.js';
import {
  FOLDER_FEATURES,
  NOISY_FEATURES,
  PEER_FEATURES,
  buildFolderDevice,
  buildPeerDevice,
  folderIds,
  peerIds,
} from './devices.js';
import { ProblemLog } from './problems.js';
import { ERROR_KINDS, SyncthingClient } from './syncthing/client.js';
import {
  FOLDER_STATES,
  completion,
  deviceName,
  failedItems,
  folderName,
  folderState,
  needsSomething,
  parseDate,
  remainingMegabytes,
  shortId,
} from './syncthing/model.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  DELETED_TEXT,
  ERROR_TEXT,
  FOLDER_STATE_TEXT,
  REPORT_TEXT,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'syncthing-hub' });

export const WIDGET_KEY = 'syncthing';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  FOLDER_SYNCED: 'folder_synced',
  SYNC_ERROR: 'sync_error',
});

export const HUB_TIMINGS = {
  // Connections and device statistics: the rates need two readings.
  refreshMs: 30_000,
  // Full reload while the event API works. `/rest/db/status` is expensive on
  // large folders (Syncthing documentation): read rarely.
  fullReloadMs: 5 * 60_000,
  // A feature that moves during a sync (progress, rates, last file) is
  // published at most this often, its last value always: a large sync stays
  // far below the 300 states per minute Gladys accepts.
  noisyMs: 30_000,
  // An unchanged value is sent again this often, so Gladys never shows
  // "no recent value" (48 h).
  heartbeatMs: 12 * 3600_000,
  // Waits before following the events again after a failure.
  eventRetryMs: [5_000, 15_000, 60_000],
  // ConfigSaved arrives in bursts (Syncthing saves twice, 5 s apart): one
  // reload after the last one.
  reloadDebounceMs: 10_000,
  // A scene action waits this long for a rescan, then lets it run on.
  scanWaitMs: 20_000,
};

const MAX_TRANSPORTS_PER_REQUEST = 100;
// Folders whose summary is read at once during a full reload.
const SUMMARY_CONCURRENCY = 4;
const MAX_TEXT = 250;
const MAX_MESSAGE = 300;

const signature = (config) => JSON.stringify([config.url, config.apiKey, config.allowSelfSigned]);

/** A text for a text feature: never empty, the end kept when too long. */
const clip = (text, max = MAX_TEXT) => (text.length > max ? `…${text.slice(-(max - 1))}` : text);

export class SyncthingHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {Function} [options.request] HTTP seam (src/syncthing/http.js)
   * @param {boolean} [options.timers] the periodic refresh (off in most tests)
   * @param {boolean} [options.events] follow the event API
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, request, timers = true, events = true, timings, now }) {
    this.gladys = gladys;
    this.request = request;
    this.timersEnabled = timers;
    this.eventsEnabled = events;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.client = null;
    // Incremented at every reconfiguration: an answer of the previous
    // Syncthing is dropped.
    this.generation = 0;
    this.stopped = false;
    this.resetState();
    // What fails again at every cycle (Gladys refusing): one line when it
    // starts, one when it ends.
    this.problems = new ProblemLog(logger);
  }

  resetState() {
    /** @type {{ id: string, short: string, startTime: string|null, version: string|null }|null} */
    this.local = null;
    /** @type {Map<string, object>} folders, by folder ID */
    this.folders = new Map();
    /** @type {Map<string, object>} remote devices, by device ID */
    this.peers = new Map();
    /** @type {{ kind: string, message: string }|null} the last reading failure */
    this.error = null;
    this.readAt = 0;
    this.fullReloadAt = 0;
    this.since = null;
    this.eventsHealthy = false;
    this.discovered = null;
    this.connection = null;
    this.transports = new Map();
    /** Last value handed to Gladys for each noisy feature, and when. */
    this.noisy = new Map();
    this.widgetDirty = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it may have restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.discovered = null;
    this.connection = null;
    this.transports.clear();
    this.noisy.clear();
    if (this.config && signature(this.config) === signature(config)) {
      this.config = config;
      await this.fullReload({ publish: true });
      return;
    }
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    if (previous && signature(previous) === signature(config)) {
      // Same Syncthing, maybe another language: the device names change.
      if (previous.language !== config.language) {
        this.discovered = null;
        this.widgetDirty = true;
      }
      await this.afterChanges({ publish: true });
      return;
    }
    this.halt();
    this.stopped = false;
    this.generation += 1;
    this.resetState();
    this.client = isConfigured(config)
      ? new SyncthingClient({
          url: config.url,
          apiKey: config.apiKey,
          insecure: config.allowSelfSigned,
          request: this.request,
        })
      : null;
    if (!this.client) {
      logger.info(
        config.invalidUrl
          ? 'The address of Syncthing is not understood'
          : 'Not configured yet: waiting for the address and the API key of Syncthing',
      );
      await this.afterChanges({ publish: true });
      return;
    }
    if (this.eventsEnabled) {
      // Where the events start, taken before the first reading so that
      // nothing happening in between is missed.
      try {
        this.since = await this.client.latestEventId();
        this.eventsHealthy = true;
      } catch (err) {
        logger.debug(`No event id yet: ${err.message}`);
      }
    }
    await this.fullReload({ publish: true });
    this.startEvents();
    this.scheduleRefresh();
  }

  /** Stop the timers and the event stream (a new configuration, a shutdown). */
  halt() {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.reloadTimer);
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.refreshTimer = null;
    this.reloadTimer = null;
    this.flushTimer = null;
    this.retryTimer = null;
    this.eventAbort?.abort();
    this.eventAbort = null;
    this.retryWake?.();
  }

  async stop() {
    this.stopped = true;
    this.halt();
    await this.eventLoop?.catch(() => {});
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refresh();
        this.problems.recover('refresh', 'Reading Syncthing works again');
      } catch (err) {
        this.problems.fail('refresh', `Refresh failed: ${err.message}`, 'error');
      }
      this.scheduleRefresh();
    }, this.timings.refreshMs);
  }

  // --- Reading Syncthing -------------------------------------------------------

  /**
   * The periodic reading: connections and device statistics, or everything
   * when the last full reload is old (or the event API does not work).
   */
  async refresh() {
    if (!this.client) {
      return;
    }
    const due = this.now() - this.fullReloadAt >= this.timings.fullReloadMs;
    if (due || !this.eventsHealthy || !this.local) {
      await this.fullReload();
      return;
    }
    const generation = this.generation;
    try {
      const [connections, deviceStats] = await Promise.all([
        this.client.connections(),
        this.client.deviceStats(),
      ]);
      if (generation !== this.generation) {
        return;
      }
      this.applyConnections(connections, deviceStats);
      this.markSuccess();
    } catch (err) {
      if (!err.kind || generation !== this.generation) {
        throw err;
      }
      this.markFailure(err);
    }
    await this.afterChanges();
  }

  /** Read everything again. Concurrent calls share the reading. */
  fullReload({ publish = false } = {}) {
    if (publish) {
      this.discovered = null;
    }
    this.reloading ??= this.readAll().finally(() => {
      this.reloading = null;
    });
    return this.reloading;
  }

  async readAll() {
    const generation = this.generation;
    const client = this.client;
    if (!client) {
      await this.afterChanges();
      return;
    }
    try {
      const status = await client.status();
      const restarted = this.local !== null && this.local.startTime !== status.startTime;
      if (this.local && this.local.id !== status.myID) {
        // Another Syncthing answers at this address: start over.
        logger.info('Another Syncthing answers at this address');
        this.folders.clear();
        this.peers.clear();
        this.discovered = null;
        this.local = null;
      }
      let version = this.local?.version ?? null;
      if (!this.local || restarted) {
        version = (await client.version())?.version ?? null;
      }
      const [folders, devices] = await Promise.all([client.folders(), client.devices()]);
      const summaries = await this.readSummaries(client, Array.isArray(folders) ? folders : []);
      const [folderStats, deviceStats, connections] = await Promise.all([
        client.folderStats(),
        client.deviceStats(),
        client.connections(),
      ]);
      if (generation !== this.generation) {
        return;
      }
      const first = this.local === null;
      this.local = {
        id: status.myID,
        short: shortId(status.myID),
        startTime: status.startTime ?? null,
        version,
      };
      if (restarted && this.eventsEnabled) {
        // Its event ids started over: follow from its last event.
        logger.info('Syncthing restarted');
        this.since = null;
        this.eventAbort?.abort();
      }
      const events = [];
      this.applyFolders(Array.isArray(folders) ? folders : [], summaries, folderStats, events);
      this.applyPeers(Array.isArray(devices) ? devices : [], connections, deviceStats);
      await this.readFailedItems(client, generation);
      this.fullReloadAt = this.now();
      this.markSuccess({ first });
      await this.fireEvents(events);
    } catch (err) {
      if (!err.kind || generation !== this.generation) {
        if (generation === this.generation) {
          throw err;
        }
        return;
      }
      this.markFailure(err);
    }
    await this.afterChanges();
  }

  /** The summary of every folder, a few at a time; a folder that fails keeps none. */
  async readSummaries(client, folders) {
    const summaries = new Map();
    const queue = [...folders];
    const worker = async () => {
      while (queue.length > 0) {
        const folder = queue.shift();
        try {
          summaries.set(folder.id, await client.folderStatus(folder.id));
        } catch (err) {
          if (err.kind !== ERROR_KINDS.HTTP) {
            throw err;
          }
          logger.debug(`Folder ${folder.id}: no summary (${err.message})`);
        }
      }
    };
    await Promise.all(Array.from({ length: SUMMARY_CONCURRENCY }, worker));
    return summaries;
  }

  /** The failed items of the folders that have some and no list yet (for the messages). */
  async readFailedItems(client, generation) {
    for (const folder of this.folders.values()) {
      if (failedItems(folder.summary) > 0 && folder.errorList.length === 0) {
        try {
          const errors = await client.folderErrors(folder.id);
          if (generation === this.generation) {
            folder.errorList = errors;
          }
        } catch (err) {
          logger.debug(`Folder ${folder.id}: no error list (${err.message})`);
        }
      }
    }
  }

  markSuccess({ first = false } = {}) {
    const wasError = this.error;
    this.error = null;
    this.readAt = this.now();
    if (first || wasError) {
      const peers = [...this.peers.values()];
      logger.info(
        `${wasError ? 'Syncthing answers again' : 'Connected to Syncthing'}: ` +
          `${this.local?.version ?? 'unknown version'} (${this.local?.short}), ` +
          `${this.folders.size} folder(s), ${peers.filter((p) => p.connected).length}/` +
          `${peers.length} remote device(s) connected`,
      );
      this.widgetDirty = true;
    }
  }

  markFailure(err) {
    const was = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (was !== err.kind) {
      logger.warn(`Syncthing at ${hostOf(this.config.url)}: ${err.message}`);
      this.widgetDirty = true;
    } else {
      logger.debug(`Syncthing still failing: ${err.message}`);
    }
  }

  // --- The model ---------------------------------------------------------------

  newFolder(id) {
    return {
      id,
      name: id,
      type: 'sendreceive',
      paused: false,
      state: null,
      summary: null,
      folderError: null,
      errorList: [],
      lastFile: null,
      status: undefined,
      errorActive: false,
      session: { active: false, files: 0, sawNeed: false },
    };
  }

  applyFolders(list, summaries, stats, events) {
    const next = new Map();
    for (const config of list) {
      if (typeof config?.id !== 'string') {
        continue;
      }
      const folder = this.folders.get(config.id) ?? this.newFolder(config.id);
      folder.name = folderName(config);
      folder.type = config.type ?? 'sendreceive';
      folder.paused = config.paused === true;
      const summary = summaries.get(config.id);
      if (summary) {
        folder.summary = summary;
        folder.state = typeof summary.state === 'string' ? summary.state : folder.state;
        folder.folderError = summary.error || null;
        if (failedItems(summary) === 0) {
          folder.errorList = [];
        }
      }
      const last = stats?.[config.id]?.lastFile;
      if (last && last.filename && parseDate(last.at) !== null) {
        folder.lastFile = { name: last.filename, deleted: last.deleted === true };
      }
      next.set(config.id, folder);
      this.evaluate(folder, events, { closing: true });
    }
    if ([...this.folders.keys()].some((id) => !next.has(id)) || next.size !== this.folders.size) {
      this.widgetDirty = true;
    }
    this.folders = next;
  }

  newPeer(id) {
    return {
      id,
      name: shortId(id),
      paused: false,
      connected: false,
      sample: null,
      download: null,
      upload: null,
      lastSeen: null,
    };
  }

  applyPeers(list, connections, deviceStats) {
    const next = new Map();
    for (const config of list) {
      if (typeof config?.deviceID !== 'string' || config.deviceID === this.local.id) {
        continue;
      }
      const peer = this.peers.get(config.deviceID) ?? this.newPeer(config.deviceID);
      peer.name = deviceName(config);
      if (peer.paused !== (config.paused === true)) {
        this.widgetDirty = true;
      }
      peer.paused = config.paused === true;
      next.set(config.deviceID, peer);
    }
    if (next.size !== this.peers.size || [...this.peers.keys()].some((id) => !next.has(id))) {
      this.widgetDirty = true;
    }
    this.peers = next;
    this.applyConnections(connections, deviceStats);
  }

  /** Connected or not, the rates since the last reading, when last seen. */
  applyConnections(connections, deviceStats) {
    const entries = connections?.connections ?? {};
    for (const peer of this.peers.values()) {
      const entry = entries[peer.id];
      const connected = entry?.connected === true;
      if (connected !== peer.connected) {
        this.widgetDirty = true;
      }
      peer.connected = connected;
      if (typeof entry?.paused === 'boolean' && entry.paused !== peer.paused) {
        peer.paused = entry.paused;
        this.widgetDirty = true;
      }
      this.sampleRates(peer, connected ? entry : null);
      const seen = parseDate(deviceStats?.[peer.id]?.lastSeen);
      if (seen !== null && (peer.lastSeen === null || seen > peer.lastSeen)) {
        peer.lastSeen = seen;
      }
    }
  }

  sampleRates(peer, entry) {
    if (!entry) {
      peer.sample = null;
      peer.download = 0;
      peer.upload = 0;
      return;
    }
    const sample = {
      at: parseDate(entry.at) ?? this.now(),
      in: Number(entry.inBytesTotal) || 0,
      out: Number(entry.outBytesTotal) || 0,
    };
    const previous = peer.sample;
    peer.sample = sample;
    if (
      !previous ||
      sample.at <= previous.at ||
      sample.in < previous.in ||
      sample.out < previous.out
    ) {
      // First reading, or a new connection whose counters started over.
      return;
    }
    const seconds = (sample.at - previous.at) / 1000;
    const rate = (bytes) => Math.round(bytes / seconds / 100) / 10; // kB/s, one decimal
    peer.download = rate(sample.in - previous.in);
    peer.upload = rate(sample.out - previous.out);
  }

  /**
   * Compare a folder with its last state; queue the scene events of the
   * transitions. `closing`: the summary is fresh (a FolderSummary event, a
   * full reload), so a sync that ended can be told from one still running.
   */
  evaluate(folder, events, { closing = false } = {}) {
    const status = folderState(folder);
    const failing = folder.state === 'error' || failedItems(folder.summary) > 0;
    const { session } = folder;
    if (folder.status === undefined) {
      // First reading: the baseline, no event.
      folder.errorActive = failing;
      if (status === FOLDER_STATES.SYNCING || status === FOLDER_STATES.OUT_OF_SYNC) {
        session.active = true;
        session.sawNeed = needsSomething(folder.summary);
      }
      folder.status = status;
      this.widgetDirty = true;
      return;
    }

    if (
      !session.active &&
      (status === FOLDER_STATES.SYNCING || status === FOLDER_STATES.OUT_OF_SYNC)
    ) {
      session.active = true;
      session.files = 0;
      session.sawNeed = false;
    }
    if (session.active && needsSomething(folder.summary)) {
      session.sawNeed = true;
    }
    if (session.active && closing && status === FOLDER_STATES.UP_TO_DATE) {
      if (session.files > 0 || session.sawNeed) {
        logger.debug(`Folder ${folder.name}: synced (${session.files} file(s))`);
        events.push({
          key: TRIGGERS.FOLDER_SYNCED,
          data: {
            folder: this.folderExternalId(folder.id),
            folder_name: folder.name,
            files: session.files,
          },
        });
      }
      session.active = false;
      session.files = 0;
      session.sawNeed = false;
    }

    if (failing && !folder.errorActive) {
      folder.errorActive = true;
      const errors = failedItems(folder.summary);
      const message = this.errorMessage(folder);
      logger.warn(
        `Folder ${folder.name}: ${folder.state === 'error' ? 'error' : `${errors} failed item(s)`}`,
      );
      events.push({
        key: TRIGGERS.SYNC_ERROR,
        data: {
          folder: this.folderExternalId(folder.id),
          folder_name: folder.name,
          errors: Math.max(errors, folder.state === 'error' ? 1 : 0),
          message,
        },
      });
    } else if (!failing && folder.errorActive && status !== FOLDER_STATES.PAUSED) {
      folder.errorActive = false;
      logger.info(`Folder ${folder.name}: no error any more`);
    }

    if (status !== folder.status) {
      this.widgetDirty = true;
    }
    folder.status = status;
  }

  /** What went wrong, for the scene event: the folder error, or the first failed item. */
  errorMessage(folder) {
    if (folder.state === 'error' && folder.folderError) {
      return folder.folderError.slice(0, MAX_MESSAGE);
    }
    const first = folder.errorList[0];
    if (first && typeof first.error === 'string') {
      return `${first.path ?? ''}: ${first.error}`.slice(0, MAX_MESSAGE);
    }
    return '';
  }

  // --- Events --------------------------------------------------------------------

  startEvents() {
    if (!this.eventsEnabled || !this.client || this.stopped) {
      return;
    }
    const generation = this.generation;
    this.eventLoop = this.followEvents(generation).catch((err) => {
      logger.error(`Event loop stopped: ${err.message}`);
    });
  }

  async followEvents(generation) {
    let failures = 0;
    const alive = () => !this.stopped && generation === this.generation;
    while (alive()) {
      const controller = new AbortController();
      this.eventAbort = controller;
      try {
        if (this.since === null) {
          const since = await this.client.latestEventId();
          if (!alive()) {
            return;
          }
          this.since = since;
          this.eventsHealthy = true;
          // What happened before `since` comes from a full reading.
          await this.fullReload();
        }
        const events = await this.client.events(this.since, { signal: controller.signal });
        if (!alive() || controller.signal.aborted) {
          continue;
        }
        this.problems.recover('events', 'Following the Syncthing events again');
        failures = 0;
        if (events.length > 0) {
          const gap = events[0].id > this.since + 1;
          this.since = events[events.length - 1].id;
          await this.applyEvents(events);
          if (gap) {
            // Syncthing keeps a thousand events: more happened since the last call.
            logger.debug('Events were missed: reading Syncthing again');
            await this.fullReload();
          }
        }
      } catch (err) {
        if (!alive()) {
          return;
        }
        if (err.name === 'AbortError') {
          continue; // Syncthing restarted: follow again from its new last event
        }
        failures += 1;
        this.eventsHealthy = false;
        this.since = null;
        if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.AUTH) {
          // Syncthing itself is down or refuses: the readings report it.
          logger.debug(`Event stream: ${err.message}`);
        } else {
          this.problems.fail('events', `Syncthing event stream unavailable: ${err.message}`);
        }
        await this.pause(this.retryDelay(failures));
      }
    }
  }

  retryDelay(failures) {
    const delays = this.timings.eventRetryMs;
    return delays[Math.min(failures, delays.length) - 1];
  }

  /** Wait, unless the hub stops meanwhile. */
  pause(ms) {
    return new Promise((resolve) => {
      this.retryWake = () => {
        clearTimeout(this.retryTimer);
        this.retryWake = null;
        resolve();
      };
      this.retryTimer = setTimeout(() => this.retryWake?.(), ms);
    });
  }

  /** Apply a batch of events, then publish what changed. */
  async applyEvents(batch) {
    const events = [];
    let reload = false;
    for (const event of batch) {
      const data = event?.data ?? {};
      const time = parseDate(event?.time) ?? this.now();
      switch (event?.type) {
        case 'StateChanged': {
          const folder = this.folders.get(data.folder);
          if (!folder) {
            reload = true;
            break;
          }
          folder.state = data.to;
          if (data.to === 'error') {
            folder.folderError = typeof data.error === 'string' ? data.error : null;
          }
          this.evaluate(folder, events);
          break;
        }
        case 'FolderSummary': {
          const folder = this.folders.get(data.folder);
          if (!folder || !data.summary) {
            reload = !folder;
            break;
          }
          folder.summary = data.summary;
          if (typeof data.summary.state === 'string') {
            folder.state = data.summary.state;
          }
          if (failedItems(data.summary) === 0) {
            folder.errorList = [];
          }
          this.evaluate(folder, events, { closing: true });
          break;
        }
        case 'FolderErrors': {
          const folder = this.folders.get(data.folder);
          if (folder) {
            folder.errorList = Array.isArray(data.errors) ? data.errors : [];
          }
          break;
        }
        case 'FolderPaused':
        case 'FolderResumed': {
          const folder = this.folders.get(data.id);
          if (!folder) {
            reload = true;
            break;
          }
          folder.paused = event.type === 'FolderPaused';
          if (!folder.paused && folder.state === '') {
            folder.state = null; // a summary follows
          }
          this.evaluate(folder, events);
          break;
        }
        case 'ItemFinished': {
          const folder = this.folders.get(data.folder);
          if (folder && data.error === null && data.type === 'file') {
            folder.lastFile = { name: String(data.item), deleted: data.action === 'delete' };
            if (folder.session.active) {
              folder.session.files += 1;
            }
          }
          break;
        }
        case 'DeviceConnected':
        case 'DeviceDisconnected': {
          const peer = this.peers.get(data.id);
          if (!peer) {
            reload = data.id !== this.local?.id;
            break;
          }
          const connected = event.type === 'DeviceConnected';
          if (connected !== peer.connected) {
            logger.info(`Device ${peer.name} ${connected ? 'connected' : 'disconnected'}`);
            this.widgetDirty = true;
          }
          peer.connected = connected;
          peer.sample = null;
          if (!connected) {
            peer.download = 0;
            peer.upload = 0;
          }
          peer.lastSeen = Math.max(peer.lastSeen ?? 0, time);
          break;
        }
        case 'DevicePaused':
        case 'DeviceResumed': {
          const peer = this.peers.get(data.device);
          if (peer) {
            peer.paused = event.type === 'DevicePaused';
            this.widgetDirty = true;
          }
          break;
        }
        case 'ConfigSaved':
          // Its data holds the whole configuration, API key included: never
          // logged nor kept. A folder or a device may have been added.
          reload = true;
          break;
        default:
          break;
      }
    }
    await this.fireEvents(events);
    await this.afterChanges();
    if (reload) {
      this.scheduleReload();
    }
  }

  /** One reload after a burst of configuration changes. */
  scheduleReload() {
    clearTimeout(this.reloadTimer);
    if (this.stopped) {
      return;
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.fullReload().catch((err) => logger.error(`Reload failed: ${err.message}`));
    }, this.timings.reloadDebounceMs);
    this.reloadTimer.unref?.();
  }

  async fireEvents(events) {
    for (const { key, data } of events) {
      try {
        await this.gladys.publishSceneEvent(key, data);
      } catch (err) {
        this.problems.fail(`scene:${key}`, `Scene event ${key} refused: ${err.message}`);
        continue;
      }
      this.problems.recover(`scene:${key}`, `Scene event ${key} accepted again`);
    }
  }

  // --- Identities ----------------------------------------------------------------

  folderExternalId(folderId) {
    return folderIds(this.gladys, this.local.id, folderId).device;
  }

  peerExternalId(deviceId) {
    return peerIds(this.gladys, this.local.id, deviceId).device;
  }

  createdIds() {
    return new Set((this.gladys.devices ?? []).map((device) => device.external_id));
  }

  /**
   * The folder or remote device of a Gladys device external id.
   * @returns {{ kind: 'folder', folder: object }|{ kind: 'peer', peer: object }|null}
   */
  find(externalId) {
    if (!this.local || typeof externalId !== 'string') {
      return null;
    }
    for (const folder of this.folders.values()) {
      if (this.folderExternalId(folder.id) === externalId) {
        return { kind: 'folder', folder };
      }
    }
    for (const peer of this.peers.values()) {
      if (this.peerExternalId(peer.id) === externalId) {
        return { kind: 'peer', peer };
      }
    }
    return null;
  }

  // --- Publishing to Gladys ------------------------------------------------------------

  discoveredDevices() {
    if (!this.local) {
      return [];
    }
    const { language } = this.config;
    const byName = (a, b) => a.name.localeCompare(b.name);
    return [
      ...[...this.folders.values()]
        .sort(byName)
        .map((folder) => buildFolderDevice(this.gladys, this.local.id, folder, language)),
      ...[...this.peers.values()]
        .sort(byName)
        .map((peer) => buildPeerDevice(this.gladys, this.local.id, peer, language)),
    ];
  }

  /** Publish the Discovery list when it changed (a folder added, renamed…). */
  async publishDevices() {
    if (!this.local && this.discovered !== null) {
      return; // Syncthing unreachable: keep the list Gladys has
    }
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** The value of every feature of the devices added to Gladys (null: nothing to say). */
  featureValues() {
    if (!this.local) {
      return [];
    }
    const created = this.createdIds();
    const { language } = this.config;
    const values = [];
    for (const folder of this.folders.values()) {
      const ids = folderIds(this.gladys, this.local.id, folder.id);
      if (!created.has(ids.device)) {
        continue;
      }
      const status = folderState(folder);
      const live = status !== FOLDER_STATES.PAUSED && folder.summary !== null;
      const lastFile = folder.lastFile
        ? clip(
            folder.lastFile.deleted
              ? `${folder.lastFile.name} ${pick(DELETED_TEXT, language)}`
              : folder.lastFile.name,
          )
        : null;
      const upToDate =
        status === FOLDER_STATES.PAUSED || status === FOLDER_STATES.UNKNOWN
          ? null
          : status === FOLDER_STATES.UP_TO_DATE
            ? 1
            : 0;
      const entries = [
        [FOLDER_FEATURES.STATE, { text: pick(FOLDER_STATE_TEXT[status], language) }],
        [FOLDER_FEATURES.UP_TO_DATE, upToDate],
        [FOLDER_FEATURES.COMPLETION, live ? completion(folder.summary) : null],
        [FOLDER_FEATURES.REMAINING, live ? remainingMegabytes(folder.summary) : null],
        [FOLDER_FEATURES.ERRORS, live ? failedItems(folder.summary) : null],
        [FOLDER_FEATURES.LAST_FILE, lastFile ? { text: lastFile } : null],
        [FOLDER_FEATURES.PAUSED, folder.paused ? 1 : 0],
      ];
      for (const [key, value] of entries) {
        values.push({ key, externalId: ids.feature(key), value });
      }
    }
    for (const peer of this.peers.values()) {
      const ids = peerIds(this.gladys, this.local.id, peer.id);
      if (!created.has(ids.device)) {
        continue;
      }
      const offline = peer.connected
        ? 0
        : peer.lastSeen === null
          ? null
          : Math.max(0, Math.floor((this.now() - peer.lastSeen) / 3_600_000));
      const entries = [
        [PEER_FEATURES.CONNECTED, peer.connected ? 1 : 0],
        [PEER_FEATURES.PAUSED, peer.paused ? 1 : 0],
        [PEER_FEATURES.DOWNLOAD, peer.download],
        [PEER_FEATURES.UPLOAD, peer.upload],
        [PEER_FEATURES.OFFLINE_HOURS, offline],
      ];
      for (const [key, value] of entries) {
        values.push({ key, externalId: ids.feature(key), value });
      }
    }
    return values.filter((entry) => entry.value !== null && entry.value !== undefined);
  }

  /**
   * Publish the states of the added devices. The SDK sends only what changed
   * (and an unchanged value once per heartbeat); the noisy features are held
   * back while they move, their last value sent at the end of the window.
   */
  async flushStates({ force = false } = {}) {
    const now = this.now();
    const states = [];
    let held = false;
    for (const { key, externalId, value } of this.featureValues()) {
      const wire = typeof value === 'object' ? value : { state: value };
      const signatureOf = JSON.stringify(wire);
      if (NOISY_FEATURES.has(key) && !force) {
        const last = this.noisy.get(externalId);
        if (last && last.value !== signatureOf && now - last.at < this.timings.noisyMs) {
          held = true;
          continue;
        }
        if (!last || last.value !== signatureOf) {
          this.noisy.set(externalId, { value: signatureOf, at: now });
        }
      } else if (NOISY_FEATURES.has(key)) {
        this.noisy.set(externalId, { value: signatureOf, at: now });
      }
      states.push({ device_feature_external_id: externalId, ...wire });
    }
    if (held) {
      this.scheduleFlush();
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  scheduleFlush() {
    if (this.flushTimer || this.stopped) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushStates().catch((err) => logger.error(`Publishing failed: ${err.message}`));
    }, this.timings.noisyMs);
    this.flushTimer.unref?.();
  }

  async afterChanges({ publish = false } = {}) {
    if (publish) {
      this.discovered = null;
    }
    await this.publishDevices();
    await this.flushStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (this.widgetDirty) {
      this.widgetDirty = false;
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    if (!this.find(device.external_id)) {
      return;
    }
    this.gladys.forgetPublishedStates?.(device.external_id);
    for (const key of [...this.noisy.keys()]) {
      if (key.startsWith(`${device.external_id}:`)) {
        this.noisy.delete(key);
      }
    }
    this.transports.delete(device.external_id);
    await this.flushStates({ force: true });
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll): read Syncthing now. */
  async pollDevice(device) {
    if (this.find(device.external_id)) {
      await this.refresh();
    }
  }

  /** The badge of the added devices: "local", or "unreachable". */
  async publishTransports() {
    if (!this.local) {
      return;
    }
    const transport = this.error === null ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    const created = this.createdIds();
    const entries = [];
    const ids = [
      ...[...this.folders.keys()].map((id) => this.folderExternalId(id)),
      ...[...this.peers.keys()].map((id) => this.peerExternalId(id)),
    ];
    for (const externalId of ids) {
      if (created.has(externalId) && this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.problems.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.problems.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (!this.client) {
      return {
        connected: false,
        message: this.config.invalidUrl
          ? CONNECTION_TEXT.invalidUrl
          : CONNECTION_TEXT.notConfigured,
      };
    }
    if (this.error) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    return { connected: this.local !== null };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    if (!this.client || this.error || this.local) {
      const key = JSON.stringify(status);
      if (key === this.connection) {
        return;
      }
      try {
        await this.gladys.setConnectionStatus(status.connected, status.message);
        this.connection = key;
        this.problems.recover('connection', 'Connection status accepted again');
      } catch (err) {
        this.problems.fail('connection', `Connection status refused: ${err.message}`);
      }
    }
  }

  // --- Commands ------------------------------------------------------------------

  /** Throws the reason Syncthing cannot be asked, if any. */
  assertReady() {
    const { language } = this.config ?? {};
    if (!this.client) {
      throw new Error(pick(ACTION_TEXT.notConfigured, language));
    }
    if (this.error || !this.local) {
      throw new Error(pick(ERROR_TEXT[this.error?.kind ?? ERROR_KINDS.UNREACHABLE], language));
    }
  }

  /** A "Paused" switch of Gladys: pause or resume the folder or the device. */
  async setPaused(externalId, paused) {
    this.assertReady();
    const found = this.find(externalId);
    if (!found) {
      throw new Error(pick(ACTION_TEXT.unknownDevice, this.config.language));
    }
    if (found.kind === 'folder') {
      await this.pauseFolder(found.folder, paused);
    } else {
      const { peer } = found;
      await this.client.setDevicePaused(peer.id, paused);
      logger.info(`Device ${peer.name} ${paused ? 'paused' : 'resumed'} from Gladys`);
      peer.paused = paused;
      this.widgetDirty = true;
    }
    await this.afterChanges();
  }

  async pauseFolder(folder, paused) {
    await this.client.setFolderPaused(folder.id, paused);
    logger.info(`Folder ${folder.name} ${paused ? 'paused' : 'resumed'} from Gladys`);
    folder.paused = paused;
    this.evaluate(folder, []);
    this.widgetDirty = true;
  }

  /**
   * The folders a scene action targets: the chosen one, or every folder.
   * @param {string|undefined} externalId
   */
  targetFolders(externalId) {
    this.assertReady();
    const { language } = this.config;
    if (externalId) {
      const found = this.find(externalId);
      if (!found || found.kind !== 'folder') {
        throw new Error(pick(ACTION_TEXT.unknownFolder, language));
      }
      return [found.folder];
    }
    if (this.folders.size === 0) {
      throw new Error(pick(ACTION_TEXT.noFolder, language));
    }
    return [...this.folders.values()];
  }

  /** Pause or resume folders (scene actions, widget buttons). Returns how many changed. */
  async setFoldersPaused(folders, paused) {
    let changed = 0;
    for (const folder of folders) {
      if (folder.paused !== paused) {
        await this.pauseFolder(folder, paused);
        changed += 1;
      }
    }
    await this.afterChanges();
    return changed;
  }

  /** Ask for a rescan of folders; a long scan is left running. Returns how many. */
  async scanFolders(folders) {
    const active = folders.filter((folder) => !folder.paused);
    logger.info(`Rescan of ${active.length} folder(s) asked from Gladys`);
    await Promise.all(
      active.map(async (folder) => {
        let timer;
        const waited = new Promise((resolve) => {
          timer = setTimeout(resolve, this.timings.scanWaitMs);
        });
        try {
          await Promise.race([this.client.scan(folder.id), waited]);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return active.length;
  }

  // --- Views (widget, report) ------------------------------------------------------

  /** "Test the connection": read Syncthing now, one line per subject. */
  async testConnection() {
    await this.fullReload({ publish: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (!this.client || this.error) {
        message[language] = pick(this.connectionStatus().message, language);
        continue;
      }
      const folders = [...this.folders.values()];
      const peers = [...this.peers.values()];
      const lines = [
        text.ok(this.local.version ?? '?'),
        text.folders(
          folders.length,
          folders.filter((f) => folderState(f) === FOLDER_STATES.UP_TO_DATE).length,
        ),
        text.devices(peers.length, peers.filter((p) => p.connected).length),
      ];
      if (this.eventsEnabled && !this.eventsHealthy) {
        lines.push(text.noEvents);
      }
      message[language] = lines.join('\n');
    }
    return message;
  }
}
