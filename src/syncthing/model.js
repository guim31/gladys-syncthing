// -----------------------------------------------------------------------------
// Pure functions over the answers of Syncthing: identities, the state of a
// folder in a few words, its progress. No I/O, tested on real answers
// (test/fixtures/syncthing).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/** The state of a folder as the integration shows it (keys of FOLDER_STATE_TEXT). */
export const FOLDER_STATES = Object.freeze({
  UP_TO_DATE: 'up_to_date',
  SYNCING: 'syncing',
  SCANNING: 'scanning',
  OUT_OF_SYNC: 'out_of_sync',
  ERROR: 'error',
  PAUSED: 'paused',
  UNKNOWN: 'unknown',
});

// The raw states of a folder (lib/model/folderstate.go), grouped.
const SCANNING = new Set(['scanning', 'scan-waiting', 'starting']);
const SYNCING = new Set(['syncing', 'sync-waiting', 'sync-preparing', 'cleaning', 'clean-waiting']);

/**
 * The short ID Syncthing shows in its interface: the first group of the
 * device ID ("7JH26DJ" for "7JH26DJ-6MWX4G2-…").
 */
export const shortId = (deviceId) => String(deviceId).split('-')[0].toUpperCase();

/**
 * A folder ID usable in an external id. Syncthing generates `abcde-fghij`,
 * but any text is allowed ("Default Folder", "photos:2026"): such an ID is
 * replaced by a hash, stable as long as the ID does not change.
 */
export function folderKey(folderId) {
  const id = String(folderId);
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return id;
  }
  return `h${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** A date of Syncthing, null for its "never" (0001-01-01 or 1970-01-01). */
export function parseDate(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.UTC(2000, 0, 1) ? time : null;
}

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/** Items that failed to sync, as the interface counts them ("Failed Items"). */
export const failedItems = (summary) =>
  summary ? Math.max(count(summary.errors), count(summary.pullErrors)) : 0;

/** Something is still to be received (bytes, or deletions and directories). */
export const needsSomething = (summary) =>
  Boolean(summary) && (count(summary.needBytes) > 0 || count(summary.needTotalItems) > 0);

/**
 * The state of a folder in a few words.
 * @param {{ paused: boolean, state: string|null, summary: object|null }} folder
 *   `state`: the raw state (from the summary or the last StateChanged event)
 */
export function folderState({ paused, state, summary }) {
  // A paused folder reports an empty state.
  if (paused || state === '') {
    return FOLDER_STATES.PAUSED;
  }
  if (state === 'error') {
    return FOLDER_STATES.ERROR;
  }
  if (SCANNING.has(state)) {
    return FOLDER_STATES.SCANNING;
  }
  if (SYNCING.has(state)) {
    return FOLDER_STATES.SYNCING;
  }
  if (state === 'idle') {
    if (failedItems(summary) > 0) {
      return FOLDER_STATES.ERROR;
    }
    return needsSomething(summary) ? FOLDER_STATES.OUT_OF_SYNC : FOLDER_STATES.UP_TO_DATE;
  }
  return FOLDER_STATES.UNKNOWN;
}

/**
 * The share of the folder this Syncthing holds, in percent, rounded down so
 * that 100 means "everything" (Syncthing shows 99.99 % while bytes are still
 * missing). An empty folder is complete.
 */
export function completion(summary) {
  if (!summary) {
    return null;
  }
  const global = count(summary.globalBytes);
  const need = count(summary.needBytes);
  if (global === 0) {
    return need > 0 ? 0 : 100;
  }
  const percent = Math.floor((100 * Math.max(0, global - need)) / global);
  // Deletions and directories still to apply weigh no byte.
  return percent === 100 && needsSomething(summary) ? 99 : percent;
}

/** Bytes still to receive, in megabytes (one decimal). */
export function remainingMegabytes(summary) {
  if (!summary) {
    return null;
  }
  return Math.round(count(summary.needBytes) / 100_000) / 10;
}

/** The name a folder is shown with: its label, or its ID. */
export const folderName = (folder) =>
  typeof folder.label === 'string' && folder.label.trim() ? folder.label.trim() : folder.id;

/** The name a device is shown with: its name, or its short ID. */
export const deviceName = (device) =>
  typeof device.name === 'string' && device.name.trim()
    ? device.name.trim()
    : shortId(device.deviceID);
