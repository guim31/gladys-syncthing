// -----------------------------------------------------------------------------
// Syncthing client: the REST API of the Syncthing web interface
// (https://docs.syncthing.net/dev/rest.html), the API Home Assistant uses
// through aiosyncthing. Checked against real Syncthing 1.30.0, 2.0.10 and
// 2.1.6 (see test/fixtures/syncthing/README.md).
//
// Authentication: the `X-API-Key` header, the key shown in Actions →
// Settings → GUI. A missing or wrong key is refused with a 403 "CSRF Error";
// a 403 "Host check error" means the interface listens on 127.0.0.1 only and
// is reached through a name (a reverse proxy).
//
// Reads are cheap except `/rest/db/status`, which the documentation calls
// expensive on large folders: the hub reads it at most every few minutes and
// follows the folders through the event API in between.
//
// Writes are limited to what is simple and reversible: pause or resume a
// folder or a device, ask for a rescan. Nothing here deletes anything.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall, GUI on 127.0.0.1
  TLS: 'tls', // the certificate does not verify (self-signed without the option)
  AUTH: 'auth', // API key refused
  HOST_CHECK: 'host_check', // the interface only accepts an IP address or localhost
  NOT_SYNCTHING: 'not_syncthing', // something answers, not the Syncthing REST API
  REDIRECT: 'redirect', // the address redirects (usually HTTP to HTTPS)
  HTTP: 'http', // any other HTTP error
});

export class SyncthingError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status, location }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'SyncthingError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// The events the hub follows. Syncthing keeps one buffered subscription per
// list of event types: the event ids of `/rest/events?events=…` count the
// events of that list only, so the list must stay the same between two calls.
export const EVENT_TYPES = Object.freeze([
  'StateChanged',
  'FolderSummary',
  'FolderErrors',
  'FolderPaused',
  'FolderResumed',
  'ItemFinished',
  'DeviceConnected',
  'DeviceDisconnected',
  'DevicePaused',
  'DeviceResumed',
  'ConfigSaved',
]);

// How long Syncthing holds a long poll open when nothing happens.
export const EVENTS_TIMEOUT_S = 60;

export class SyncthingClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, `http(s)://host[:port][/path]`
   * @param {string} options.apiKey API key
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, apiKey, insecure = false, request = httpRequest, timeoutMs = 15_000 }) {
    this.url = url;
    this.apiKey = apiKey;
    this.insecure = insecure;
    this.request = request;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One call of the REST API.
   * @param {string} method
   * @param {string} path with its query string
   * @param {object} [options] { body (object, sent as JSON), timeoutMs, signal, json }
   * @returns {Promise<any>} the parsed JSON, or the raw text when `json` is false
   * @throws {SyncthingError} (an AbortError when `signal` aborts)
   */
  async call(method, path, { body, timeoutMs = this.timeoutMs, signal, json = true } = {}) {
    const headers = { 'x-api-key': this.apiKey, accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let response;
    try {
      response = await this.request(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        insecure: this.insecure,
        timeoutMs,
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw err;
      }
      if (TLS_CODES.has(err.code)) {
        throw new SyncthingError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
      }
      throw new SyncthingError(ERROR_KINDS.UNREACHABLE, err.code ? `${err.code}` : err.message);
    }

    const { status } = response;
    const text = typeof response.body === 'string' ? response.body : '';
    if (status === 403 && /host check/i.test(text)) {
      throw new SyncthingError(ERROR_KINDS.HOST_CHECK, 'Host check error (HTTP 403)', { status });
    }
    if (status === 401 || status === 403) {
      throw new SyncthingError(ERROR_KINDS.AUTH, `API key refused (HTTP ${status})`, { status });
    }
    if (status >= 300 && status < 400) {
      throw new SyncthingError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, {
        status,
        location: response.headers?.location,
      });
    }
    if (status < 200 || status >= 300) {
      // Syncthing answers its errors in plain text ("no such folder"): short
      // and free of secrets, kept for the logs.
      const detail = text.trim().split('\n')[0].slice(0, 120);
      const kind =
        status === 404 && path.startsWith('/rest/system/')
          ? ERROR_KINDS.NOT_SYNCTHING
          : ERROR_KINDS.HTTP;
      throw new SyncthingError(kind, `HTTP ${status}${detail ? ` (${detail})` : ''}`, { status });
    }
    if (!json) {
      return text;
    }
    if (text.trim() === '') {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      // An HTML page: another service, or the address of the web page of a
      // proxy in front of Syncthing.
      throw new SyncthingError(ERROR_KINDS.NOT_SYNCTHING, 'The answer is not Syncthing JSON');
    }
  }

  get(path, options) {
    return this.call('GET', path, options);
  }

  /** `{ myID, startTime, … }`: who answers, and since when (a restart changes it). */
  async status() {
    const status = await this.get('/rest/system/status');
    if (!status || typeof status.myID !== 'string') {
      throw new SyncthingError(ERROR_KINDS.NOT_SYNCTHING, 'No device ID in /rest/system/status');
    }
    return status;
  }

  version() {
    return this.get('/rest/system/version');
  }

  /** Configured folders (Syncthing 1.12 or later). */
  folders() {
    return this.get('/rest/config/folders');
  }

  /** Configured devices, this one included (Syncthing 1.12 or later). */
  devices() {
    return this.get('/rest/config/devices');
  }

  /** The folder summary: state, bytes and items in sync, needed, failed. Expensive. */
  folderStatus(folderId) {
    return this.get(`/rest/db/status?folder=${encodeURIComponent(folderId)}`);
  }

  /** The items that failed to sync, `[{ path, error }]`. */
  async folderErrors(folderId) {
    const answer = await this.get(
      `/rest/folder/errors?folder=${encodeURIComponent(folderId)}&perpage=20`,
    );
    return Array.isArray(answer?.errors) ? answer.errors : [];
  }

  /** Per folder: the last file synced and the last scan. */
  folderStats() {
    return this.get('/rest/stats/folder');
  }

  /** Per device: when it was last seen. */
  deviceStats() {
    return this.get('/rest/stats/device');
  }

  /** Per remote device: connected, paused, bytes received and sent so far. */
  connections() {
    return this.get('/rest/system/connections');
  }

  /**
   * The id of the last buffered event of our list (0 when none): following
   * from there skips what happened before the integration started.
   */
  async latestEventId() {
    const events = await this.get(
      `/rest/events?since=0&limit=1&timeout=0&events=${EVENT_TYPES.join(',')}`,
    );
    return Array.isArray(events) && events.length > 0 ? events[events.length - 1].id : 0;
  }

  /**
   * Long poll: the events after `since`, as soon as there is one, or [] after
   * EVENTS_TIMEOUT_S seconds.
   * @param {number} since
   * @param {{ signal?: AbortSignal }} [options]
   */
  async events(since, { signal } = {}) {
    const events = await this.get(
      `/rest/events?since=${since}&timeout=${EVENTS_TIMEOUT_S}&events=${EVENT_TYPES.join(',')}`,
      { signal, timeoutMs: (EVENTS_TIMEOUT_S + 15) * 1000 },
    );
    return Array.isArray(events) ? events : [];
  }

  setFolderPaused(folderId, paused) {
    return this.call('PATCH', `/rest/config/folders/${encodeURIComponent(folderId)}`, {
      body: { paused },
      json: false,
    });
  }

  setDevicePaused(deviceId, paused) {
    return this.call('PATCH', `/rest/config/devices/${encodeURIComponent(deviceId)}`, {
      body: { paused },
      json: false,
    });
  }

  /** Ask for a rescan of a folder (Syncthing answers once it is done). */
  scan(folderId) {
    return this.call('POST', `/rest/db/scan?folder=${encodeURIComponent(folderId)}`, {
      json: false,
      timeoutMs: 60_000,
    });
  }
}
