// -----------------------------------------------------------------------------
// The Gladys devices of a Syncthing, proposed in the Discovery tab: the user
// adds the ones to follow, nothing is created on their behalf.
//
//   - one device per folder: state in words, up to date (yes/no), progress,
//     megabytes still to receive, failed items, last file synced, and a
//     "Paused" switch (pause / resume the folder);
//   - one device per remote device (laptop, phone, other NAS): connected,
//     "Paused" switch, download and upload rates, hours offline.
//
// Identity: the short ID of the Syncthing Gladys talks to (its device ID,
// first group), then the folder ID or the short ID of the remote device. A
// new address, a renamed folder or device keep the Gladys device and its
// history; another Syncthing gets its own devices.
//
// Category/type couples come from the core table (test/gladys-rules.test.js).
// The core has no generic "percent" category: the progress is
// `level-sensor/liquid-level-percent` (0-100, as Unraid, Glances, OctoPrint).
// The front labels a feature alone of its type on a device with the device
// name; the two binary features of each device keep their own names.
//
// Published with should_poll: false: the integration follows Syncthing by
// its event API and its own timer (src/hub.js), never by the core scheduler.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORY,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import { folderKey, shortId } from './syncthing/model.js';

export const DEVICE_TYPES = Object.freeze({ FOLDER: 'folder', PEER: 'device' });

// Suffixes of the feature external ids: permanent once published.
export const FOLDER_FEATURES = Object.freeze({
  STATE: 'state',
  UP_TO_DATE: 'up_to_date',
  COMPLETION: 'completion',
  REMAINING: 'remaining',
  ERRORS: 'errors',
  LAST_FILE: 'last_file',
  PAUSED: 'paused',
});

export const PEER_FEATURES = Object.freeze({
  CONNECTED: 'connected',
  PAUSED: 'paused',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  OFFLINE_HOURS: 'offline_hours',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation.
export const NAMES = {
  en: {
    folder: {
      [FOLDER_FEATURES.STATE]: 'State',
      [FOLDER_FEATURES.UP_TO_DATE]: 'Up to date',
      [FOLDER_FEATURES.COMPLETION]: 'Progress',
      [FOLDER_FEATURES.REMAINING]: 'Left to receive',
      [FOLDER_FEATURES.ERRORS]: 'Failed items',
      [FOLDER_FEATURES.LAST_FILE]: 'Last file synced',
      [FOLDER_FEATURES.PAUSED]: 'Paused',
    },
    peer: {
      [PEER_FEATURES.CONNECTED]: 'Connected',
      [PEER_FEATURES.PAUSED]: 'Paused',
      [PEER_FEATURES.DOWNLOAD]: 'Download',
      [PEER_FEATURES.UPLOAD]: 'Upload',
      [PEER_FEATURES.OFFLINE_HOURS]: 'Offline for',
    },
  },
  fr: {
    folder: {
      [FOLDER_FEATURES.STATE]: 'État',
      [FOLDER_FEATURES.UP_TO_DATE]: 'À jour',
      [FOLDER_FEATURES.COMPLETION]: 'Progression',
      [FOLDER_FEATURES.REMAINING]: 'Reste à recevoir',
      [FOLDER_FEATURES.ERRORS]: 'Éléments en échec',
      [FOLDER_FEATURES.LAST_FILE]: 'Dernier fichier synchronisé',
      [FOLDER_FEATURES.PAUSED]: 'En pause',
    },
    peer: {
      [PEER_FEATURES.CONNECTED]: 'Connecté',
      [PEER_FEATURES.PAUSED]: 'En pause',
      [PEER_FEATURES.DOWNLOAD]: 'Réception',
      [PEER_FEATURES.UPLOAD]: 'Envoi',
      [PEER_FEATURES.OFFLINE_HOURS]: 'Hors ligne depuis',
    },
  },
  de: {
    folder: {
      [FOLDER_FEATURES.STATE]: 'Status',
      [FOLDER_FEATURES.UP_TO_DATE]: 'Aktuell',
      [FOLDER_FEATURES.COMPLETION]: 'Fortschritt',
      [FOLDER_FEATURES.REMAINING]: 'Noch zu empfangen',
      [FOLDER_FEATURES.ERRORS]: 'Fehlgeschlagene Elemente',
      [FOLDER_FEATURES.LAST_FILE]: 'Zuletzt synchronisierte Datei',
      [FOLDER_FEATURES.PAUSED]: 'Pausiert',
    },
    peer: {
      [PEER_FEATURES.CONNECTED]: 'Verbunden',
      [PEER_FEATURES.PAUSED]: 'Pausiert',
      [PEER_FEATURES.DOWNLOAD]: 'Download',
      [PEER_FEATURES.UPLOAD]: 'Upload',
      [PEER_FEATURES.OFFLINE_HOURS]: 'Offline seit',
    },
  },
  es: {
    folder: {
      [FOLDER_FEATURES.STATE]: 'Estado',
      [FOLDER_FEATURES.UP_TO_DATE]: 'Actualizado',
      [FOLDER_FEATURES.COMPLETION]: 'Progreso',
      [FOLDER_FEATURES.REMAINING]: 'Pendiente de recibir',
      [FOLDER_FEATURES.ERRORS]: 'Elementos fallidos',
      [FOLDER_FEATURES.LAST_FILE]: 'Último archivo sincronizado',
      [FOLDER_FEATURES.PAUSED]: 'En pausa',
    },
    peer: {
      [PEER_FEATURES.CONNECTED]: 'Conectado',
      [PEER_FEATURES.PAUSED]: 'En pausa',
      [PEER_FEATURES.DOWNLOAD]: 'Descarga',
      [PEER_FEATURES.UPLOAD]: 'Subida',
      [PEER_FEATURES.OFFLINE_HOURS]: 'Desconectado desde hace',
    },
  },
};

// Display bounds (the core never applies them on write).
export const BOUNDS = Object.freeze({
  REMAINING_MB: 10_000_000, // 10 TB
  ERRORS: 100_000,
  RATE_KBPS: 1_000_000, // 1 GB/s
  OFFLINE_HOURS: 87_600, // 10 years
});

// Features that move during a sync: published at most once per
// NOISY_INTERVAL_MS each (src/hub.js), the last value always.
export const NOISY_FEATURES = new Set([
  FOLDER_FEATURES.COMPLETION,
  FOLDER_FEATURES.REMAINING,
  FOLDER_FEATURES.LAST_FILE,
  PEER_FEATURES.DOWNLOAD,
  PEER_FEATURES.UPLOAD,
]);

export const MODEL = 'Syncthing';
export const PARAMS = Object.freeze({
  FOLDER_ID: 'SYNCTHING_FOLDER_ID',
  FOLDER_TYPE: 'SYNCTHING_FOLDER_TYPE',
  DEVICE_ID: 'SYNCTHING_DEVICE_ID',
});

/** External ids of a folder's device and features. */
export const folderIds = (gladys, localId, folderId) =>
  gladys.externalIds(DEVICE_TYPES.FOLDER, `${shortId(localId)}-${folderKey(folderId)}`);

/** External ids of a remote device's device and features. */
export const peerIds = (gladys, localId, deviceId) =>
  gladys.externalIds(DEVICE_TYPES.PEER, `${shortId(localId)}-${shortId(deviceId)}`);

const feature = (name, externalId, definition, extra = {}) => ({
  name,
  external_id: externalId,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
  ...extra,
});

// min/max are NOT NULL in Gladys, text features included.
const TEXT = { category: CATEGORY.TEXT, type: TYPE.TEXT.TEXT, min: 0, max: 0 };
const BINARY_SENSOR = { category: CATEGORY.INPUT, type: TYPE.SENSOR.BINARY, min: 0, max: 1 };
const SWITCH = { category: CATEGORY.SWITCH, type: TYPE.SWITCH.BINARY, min: 0, max: 1 };
const rate = {
  category: CATEGORY.DATARATE,
  type: TYPE.DATARATE.RATE,
  unit: UNIT.KILOBYTES_PER_SECOND,
  min: 0,
  max: BOUNDS.RATE_KBPS,
};

/**
 * The discovery payload of a folder.
 * @param {object} gladys SDK client
 * @param {string} localId device ID of the Syncthing
 * @param {{ id: string, name: string, type: string }} folder
 * @param {string} language feature names language
 */
export function buildFolderDevice(gladys, localId, folder, language = 'en') {
  const ids = folderIds(gladys, localId, folder.id);
  const names = (NAMES[language] ?? NAMES.en).folder;
  const f = (key, definition, extra) => feature(names[key], ids.feature(key), definition, extra);
  return {
    name: folder.name.slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [
      { name: PARAMS.FOLDER_ID, value: String(folder.id).slice(0, 255) },
      { name: PARAMS.FOLDER_TYPE, value: String(folder.type ?? '') || 'sendreceive' },
    ],
    features: [
      // A text state keeps no useful history: the binary below has it.
      f(FOLDER_FEATURES.STATE, TEXT, { keep_history: false }),
      f(FOLDER_FEATURES.UP_TO_DATE, BINARY_SENSOR),
      f(FOLDER_FEATURES.COMPLETION, {
        category: CATEGORY.LEVEL_SENSOR,
        type: TYPE.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
        unit: UNIT.PERCENT,
        min: 0,
        max: 100,
      }),
      f(FOLDER_FEATURES.REMAINING, {
        category: CATEGORY.DATA,
        type: TYPE.DATA.SIZE,
        unit: UNIT.MEGABYTE,
        min: 0,
        max: BOUNDS.REMAINING_MB,
      }),
      f(FOLDER_FEATURES.ERRORS, {
        category: CATEGORY.COUNTER_SENSOR,
        type: TYPE.SENSOR.INTEGER,
        min: 0,
        max: BOUNDS.ERRORS,
      }),
      f(FOLDER_FEATURES.LAST_FILE, TEXT, { keep_history: false }),
      f(FOLDER_FEATURES.PAUSED, SWITCH, { read_only: false, has_feedback: true }),
    ],
  };
}

/**
 * The discovery payload of a remote device.
 * @param {object} gladys SDK client
 * @param {string} localId device ID of the Syncthing
 * @param {{ id: string, name: string }} peer
 * @param {string} language feature names language
 */
export function buildPeerDevice(gladys, localId, peer, language = 'en') {
  const ids = peerIds(gladys, localId, peer.id);
  const names = (NAMES[language] ?? NAMES.en).peer;
  const f = (key, definition, extra) => feature(names[key], ids.feature(key), definition, extra);
  return {
    name: peer.name.slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [{ name: PARAMS.DEVICE_ID, value: peer.id }],
    features: [
      f(PEER_FEATURES.CONNECTED, BINARY_SENSOR),
      f(PEER_FEATURES.PAUSED, SWITCH, { read_only: false, has_feedback: true }),
      f(PEER_FEATURES.DOWNLOAD, rate),
      f(PEER_FEATURES.UPLOAD, rate),
      f(PEER_FEATURES.OFFLINE_HOURS, {
        category: CATEGORY.DURATION,
        type: TYPE.DURATION.INTEGER,
        unit: UNIT.HOURS,
        min: 0,
        max: BOUNDS.OFFLINE_HOURS,
      }),
    ],
  };
}
