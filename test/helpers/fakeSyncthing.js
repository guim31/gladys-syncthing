// -----------------------------------------------------------------------------
// An in-memory Syncthing behind the `request` seam of src/syncthing/http.js.
// Its answers start from the real ones recorded in test/fixtures/syncthing
// (Syncthing 2.1.6 and 1.30.0, anonymized), and it behaves like the real one
// where the integration depends on it:
//   - `X-API-Key` checked, a wrong key refused with 403 "CSRF Error";
//   - `/rest/events` long poll: answers at once when events wait, holds the
//     request until `emit()` otherwise, honors `since`, `limit`, `timeout=0`
//     and the abort signal; ids count the events of the subscription;
//   - pausing a folder or a device emits the events Syncthing emits.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const API_KEY = 'gladys-test-key-6f1c2d';
export const BASE_URL = 'http://192.0.2.10:8384';

const fixtureDir = new URL('../fixtures/syncthing/', import.meta.url);

/** A recorded answer of Syncthing. */
export function fixture(path) {
  return JSON.parse(readFileSync(new URL(path, fixtureDir), 'utf8'));
}

export const VERSIONS = {
  'v2.1.6': {
    // The Syncthing Gladys talks to, sharing two folders with "laptop".
    summaries: { 'photos-x7k2': 'db-status-photos.json', docs: 'db-status-docs.json' },
  },
  'v1.30.0': {
    // "laptop": three folders, one of them (default) shared with nobody.
    summaries: {
      // Photos as it ended the recorded sync: idle, everything received.
      'photos-x7k2': 'events-recovered.json#FolderSummary',
      docs: 'db-status-default.json',
      default: 'db-status-default.json',
    },
  },
};

const json = (status, value) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});
const text = (status, value) => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: value,
});

const networkError = (code) => Object.assign(new Error(code), { code });

function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export class FakeSyncthing {
  /**
   * @param {object} [options]
   * @param {keyof VERSIONS} [options.version] the recorded Syncthing to start from
   */
  constructor({ version = 'v2.1.6' } = {}) {
    const load = (name) => fixture(`${version}/${name}`);
    this.version = version;
    this.status = load('system-status.json');
    this.versionInfo = load('system-version.json');
    this.folders = load('config-folders.json');
    this.devices = load('config-devices.json');
    const summaryOf = (id, file) => {
      const [name, type] = file.split('#');
      if (!type) {
        return load(name);
      }
      return load(name).findLast((event) => event.type === type && event.data.folder === id).data
        .summary;
    };
    this.summaries = new Map(
      Object.entries(VERSIONS[version].summaries).map(([id, file]) => [id, summaryOf(id, file)]),
    );
    this.folderStats = load('stats-folder.json');
    this.deviceStats = load('stats-device.json');
    this.connections = load('system-connections.json');
    this.folderErrors = new Map();
    /** @type {Array<object>} the events of the subscription, ids from 1 */
    this.events = [];
    this.lastId = 0;
    this.polls = [];
    /** null, 'down' (refused), 'tls', or a response `{ status, body }` for every call */
    this.failure = null;
    /** a response `{ status, body }` for the event API only */
    this.eventsFailure = null;
    /** @type {Array<{ method: string, path: string, body?: object }>} */
    this.calls = [];
    this.apiKey = API_KEY;
    this.scanHang = false;
    this.request = (url, options) => this.handle(url, options);
  }

  get myID() {
    return this.status.myID;
  }

  /** The remote devices (not this Syncthing). */
  get remoteIds() {
    return this.devices.map((d) => d.deviceID).filter((id) => id !== this.myID);
  }

  /** Calls made to one path (query string excluded). */
  callsTo(path) {
    return this.calls.filter((call) => call.path.split('?')[0] === path);
  }

  /** Add events (`{ type, data, time? }`) to the subscription; wake the long polls. */
  emit(...events) {
    for (const event of events.flat()) {
      this.lastId += 1;
      this.events.push({
        id: this.lastId,
        globalID: this.lastId + 100,
        time: event.time ?? new Date().toISOString(),
        type: event.type,
        data: structuredClone(event.data ?? {}),
      });
    }
    this.wakePolls();
  }

  /** Replay recorded events (their ids are renumbered), applying the summaries they carry. */
  replay(recorded) {
    for (const event of recorded) {
      if (event.type === 'FolderSummary') {
        this.summaries.set(event.data.folder, structuredClone(event.data.summary));
      }
    }
    this.emit(recorded.map(({ type, data, time }) => ({ type, data, time })));
  }

  /** Events dropped from the buffer of Syncthing (a client that read too slowly). */
  skip(count) {
    this.lastId += count;
  }

  /** Change the summary of a folder (what `/rest/db/status` answers). */
  setSummary(folderId, patch) {
    this.summaries.set(folderId, { ...this.summaries.get(folderId), ...patch });
  }

  /** Change the connection of a remote device. */
  setConnection(deviceId, patch) {
    const entry = this.connections.connections[deviceId] ?? {};
    this.connections.connections[deviceId] = { ...entry, ...patch };
  }

  /** Syncthing restarts: new start time, the event ids start over. */
  restart() {
    this.status = { ...this.status, startTime: new Date(Date.now() + 1000).toISOString() };
    this.events = [];
    this.lastId = 0;
    for (const poll of this.polls.splice(0)) {
      poll.reject(networkError('ECONNRESET'));
    }
  }

  /** Syncthing goes down (or back up with `null`). */
  setFailure(failure) {
    this.failure = failure;
    if (failure) {
      for (const poll of this.polls.splice(0)) {
        poll.reject(networkError('ECONNRESET'));
      }
    }
  }

  /** Resolve the pending long polls with nothing (their timeout). */
  timeoutPolls() {
    for (const poll of this.polls.splice(0)) {
      poll.resolve(json(200, []));
    }
  }

  wakePolls() {
    const pending = this.polls.splice(0);
    for (const poll of pending) {
      const answer = this.after(poll.since, poll.limit);
      if (answer.length > 0) {
        poll.resolve(json(200, answer));
      } else {
        this.polls.push(poll);
      }
    }
  }

  after(since, limit) {
    const events = this.events.filter((event) => event.id > since);
    return limit ? events.slice(-limit) : events;
  }

  async handle(url, { method = 'GET', headers = {}, body, signal } = {}) {
    const target = new URL(url);
    const path = `${target.pathname}${target.search}`;
    const parsedBody = body === undefined ? undefined : JSON.parse(body);
    this.calls.push({ method, path, ...(parsedBody === undefined ? {} : { body: parsedBody }) });
    if (signal?.aborted) {
      throw abortError();
    }
    if (this.failure === 'down') {
      throw networkError('ECONNREFUSED');
    }
    if (this.failure === 'tls') {
      throw networkError('DEPTH_ZERO_SELF_SIGNED_CERT');
    }
    if (this.failure) {
      return text(this.failure.status, this.failure.body ?? '');
    }
    if (headers['x-api-key'] !== this.apiKey) {
      return text(403, 'CSRF Error\n');
    }
    return this.route(method, target, parsedBody, signal);
  }

  route(method, target, body, signal) {
    const { pathname, searchParams } = target;
    const folderParam = searchParams.get('folder');
    if (method === 'GET') {
      switch (pathname) {
        case '/rest/system/status':
          return json(200, this.status);
        case '/rest/system/version':
          return json(200, this.versionInfo);
        case '/rest/config/folders':
          return json(200, this.folders);
        case '/rest/config/devices':
          return json(200, this.devices);
        case '/rest/db/status': {
          const folder = this.folders.find((f) => f.id === folderParam);
          if (!folder) {
            return text(404, 'no such folder\n');
          }
          const summary = structuredClone(this.summaries.get(folderParam) ?? {});
          if (folder.paused) {
            summary.state = '';
          }
          return json(200, summary);
        }
        case '/rest/folder/errors':
          return json(200, {
            errors: this.folderErrors.get(folderParam) ?? null,
            folder: folderParam,
            page: 1,
            perpage: 20,
          });
        case '/rest/stats/folder':
          return json(200, this.folderStats);
        case '/rest/stats/device':
          return json(200, this.deviceStats);
        case '/rest/system/connections':
          return json(200, this.connections);
        case '/rest/events':
          return this.longPoll(searchParams, signal);
        default:
          return text(404, '404 page not found\n');
      }
    }
    const folderMatch = pathname.match(/^\/rest\/config\/folders\/(.+)$/);
    if (method === 'PATCH' && folderMatch) {
      const id = decodeURIComponent(folderMatch[1]);
      const folder = this.folders.find((f) => f.id === id);
      if (!folder) {
        return text(404, 'No folder with given ID\n');
      }
      if (typeof body?.paused === 'boolean' && body.paused !== folder.paused) {
        folder.paused = body.paused;
        this.emit(
          {
            type: body.paused ? 'FolderPaused' : 'FolderResumed',
            data: { id, label: folder.label },
          },
          { type: 'ConfigSaved', data: { version: 52 } },
        );
      }
      return text(200, '');
    }
    const deviceMatch = pathname.match(/^\/rest\/config\/devices\/(.+)$/);
    if (method === 'PATCH' && deviceMatch) {
      const id = decodeURIComponent(deviceMatch[1]);
      const device = this.devices.find((d) => d.deviceID === id);
      if (!device) {
        return text(404, 'No device with given ID\n');
      }
      if (typeof body?.paused === 'boolean' && body.paused !== device.paused) {
        device.paused = body.paused;
        this.setConnection(id, { paused: body.paused, connected: !body.paused });
        this.emit(
          { type: body.paused ? 'DevicePaused' : 'DeviceResumed', data: { device: id } },
          body.paused
            ? { type: 'DeviceDisconnected', data: { id, error: 'device is paused' } }
            : { type: 'DeviceConnected', data: { id, addr: '192.0.2.20:22000' } },
          { type: 'ConfigSaved', data: { version: 52 } },
        );
      }
      return text(200, '');
    }
    if (method === 'POST' && pathname === '/rest/db/scan') {
      if (!this.folders.some((f) => f.id === folderParam)) {
        return text(500, 'no such folder\n');
      }
      if (this.scanHang) {
        return new Promise(() => {});
      }
      return text(200, '');
    }
    return text(404, '404 page not found\n');
  }

  longPoll(searchParams, signal) {
    if (this.eventsFailure) {
      return text(this.eventsFailure.status, this.eventsFailure.body ?? '');
    }
    const since = Number(searchParams.get('since') ?? 0);
    const limit = Number(searchParams.get('limit') ?? 0);
    const answer = this.after(since, limit);
    if (answer.length > 0 || searchParams.get('timeout') === '0') {
      return json(200, answer);
    }
    return new Promise((resolve, reject) => {
      const poll = { since, limit, resolve, reject };
      this.polls.push(poll);
      signal?.addEventListener('abort', () => {
        this.polls = this.polls.filter((p) => p !== poll);
        reject(abortError());
      });
    });
  }
}
