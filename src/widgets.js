// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `syncthing`.
//
// The use case: a glance at the wall tablet tells whether everything is in
// sync, and which folder or device is not. So the widget shows the folders up
// to date, the devices connected, the transfer rates, and one row per folder
// and device — the problems first — with the state in words. Three buttons:
// rescan every folder, pause every folder, resume them.
//
// Every folder and device of Syncthing, added to Gladys or not; the settings
// pick folders only or devices only. The figures are sent as values, not
// bound to device features: the widget works before any device is added.
//
// Budget (8 components, 6 tiles, 2 texts, 1 status, 4 buttons): four tiles at
// most, one text when Syncthing does not answer, one status list of ten rows,
// three buttons with distinct action keys.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';
import { FOLDER_STATES, completion, folderState } from './syncthing/model.js';
import {
  CONNECTION_TEXT,
  DEVICE_STATE_TEXT,
  ERROR_TEXT,
  FOLDER_STATE_TEXT,
  OFFLINE_TEXT,
  pick,
} from './texts.js';

// Action keys of the buttons: permanent once published.
export const ACTIONS = Object.freeze({ RESCAN: 'rescan', PAUSE: 'pause', RESUME: 'resume' });

// Values of the "show" setting.
export const SHOW = Object.freeze({ ALL: 'all', FOLDERS: 'folders', DEVICES: 'devices' });

export const MAX_ROWS = 10;

export const TEXT = {
  empty: {
    en: 'No folder and no remote device in Syncthing yet.',
    fr: 'Aucun dossier ni appareil distant dans Syncthing pour le moment.',
    de: 'Noch kein Ordner und kein entferntes Gerät in Syncthing.',
    es: 'Todavía no hay carpetas ni dispositivos remotos en Syncthing.',
  },
  folders: {
    en: 'Folders up to date',
    fr: 'Dossiers à jour',
    de: 'Ordner aktuell',
    es: 'Carpetas al día',
  },
  devices: {
    en: 'Devices connected',
    fr: 'Appareils connectés',
    de: 'Geräte verbunden',
    es: 'Equipos conectados',
  },
  download: { en: 'Download', fr: 'Réception', de: 'Download', es: 'Descarga' },
  upload: { en: 'Upload', fr: 'Envoi', de: 'Upload', es: 'Subida' },
  kbps: { en: 'kB/s', fr: 'ko/s', de: 'kB/s', es: 'kB/s' },
  mbps: { en: 'MB/s', fr: 'Mo/s', de: 'MB/s', es: 'MB/s' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  rescan: { en: 'Rescan', fr: 'Analyser', de: 'Neu scannen', es: 'Analizar' },
  pause: { en: 'Pause all', fr: 'Tout suspendre', de: 'Alle pausieren', es: 'Pausar todo' },
  resume: { en: 'Resume all', fr: 'Tout reprendre', de: 'Alle fortsetzen', es: 'Reanudar todo' },
};

// Toasts of the buttons.
export const TOAST_TEXT = {
  en: {
    rescan: (n) => `Rescan asked for ${n} folder(s).`,
    pause: (n) => `${n} folder(s) paused.`,
    resume: (n) => `${n} folder(s) resumed.`,
  },
  fr: {
    rescan: (n) => `Analyse demandée pour ${n} dossier(s).`,
    pause: (n) => `${n} dossier(s) en pause.`,
    resume: (n) => `${n} dossier(s) repris.`,
  },
  de: {
    rescan: (n) => `Neuer Scan für ${n} Ordner angefordert.`,
    pause: (n) => `${n} Ordner pausiert.`,
    resume: (n) => `${n} Ordner fortgesetzt.`,
  },
  es: {
    rescan: (n) => `Análisis solicitado para ${n} carpeta(s).`,
    pause: (n) => `${n} carpeta(s) en pausa.`,
    resume: (n) => `${n} carpeta(s) reanudada(s).`,
  },
};

// Row order: what needs attention first.
const SEVERITY = [
  'folder:error',
  'folder:out_of_sync',
  'device:disconnected',
  'folder:unknown',
  'folder:syncing',
  'folder:scanning',
  'device:never',
  'folder:paused',
  'device:paused',
  'folder:up_to_date',
  'device:connected',
];

const ROW_STYLE = {
  'folder:up_to_date': { icon: 'check-circle', color: WIDGET_COLORS.SUCCESS },
  'folder:syncing': { icon: 'refresh-cw', color: WIDGET_COLORS.INFO },
  'folder:scanning': { icon: 'search', color: WIDGET_COLORS.INFO },
  'folder:out_of_sync': { icon: 'alert-circle', color: WIDGET_COLORS.WARNING },
  'folder:error': { icon: 'x-circle', color: WIDGET_COLORS.DANGER },
  'folder:paused': { icon: 'pause-circle', color: WIDGET_COLORS.NEUTRAL },
  'folder:unknown': { icon: 'help-circle', color: WIDGET_COLORS.NEUTRAL },
  'device:connected': { icon: 'link', color: WIDGET_COLORS.SUCCESS },
  'device:disconnected': { icon: 'wifi-off', color: WIDGET_COLORS.WARNING },
  'device:never': { icon: 'help-circle', color: WIDGET_COLORS.NEUTRAL },
  'device:paused': { icon: 'pause-circle', color: WIDGET_COLORS.NEUTRAL },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language, ttl = 300) {
  return {
    ttl_seconds: ttl,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** How long a remote device has been offline, in words. */
export function offlineText(hours, language) {
  const text = OFFLINE_TEXT[language] ?? OFFLINE_TEXT.en;
  return hours >= 48 ? text.days(Math.floor(hours / 24)) : text.hours(hours);
}

/** The rows of the status list, sorted (problems first). */
export function buildRows(hub, show, language) {
  const rows = [];
  if (show !== SHOW.DEVICES) {
    for (const folder of hub.folders.values()) {
      const status = folderState(folder);
      let value = t(FOLDER_STATE_TEXT[status], language);
      const percent = completion(folder.summary);
      if (status === FOLDER_STATES.SYNCING && percent !== null && percent < 100) {
        value = `${value} · ${percent} %`;
      }
      rows.push({ kind: `folder:${status}`, name: folder.name, value });
    }
  }
  if (show !== SHOW.FOLDERS) {
    const now = hub.now();
    for (const peer of hub.peers.values()) {
      let kind;
      let value;
      if (peer.paused) {
        kind = 'device:paused';
        value = t(DEVICE_STATE_TEXT.paused, language);
      } else if (peer.connected) {
        kind = 'device:connected';
        value = t(DEVICE_STATE_TEXT.connected, language);
      } else if (peer.lastSeen === null) {
        kind = 'device:never';
        value = t(DEVICE_STATE_TEXT.never, language);
      } else {
        kind = 'device:disconnected';
        const hours = Math.max(0, Math.floor((now - peer.lastSeen) / 3_600_000));
        value =
          hours < 1 ? t(DEVICE_STATE_TEXT.disconnected, language) : offlineText(hours, language);
      }
      rows.push({ kind, name: peer.name, value });
    }
  }
  return rows.sort(
    (a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}

/** A rate tile: kB/s, or MB/s from 1000 kB/s. */
function rateTile(kbps, label, icon, language) {
  const fast = kbps >= 1000;
  return {
    type: 'value',
    value: fast ? Math.round(kbps / 100) / 10 : Math.round(kbps),
    unit: t(fast ? TEXT.mbps : TEXT.kbps, language),
    label: t(label, language),
    icon,
    color: WIDGET_COLORS.NEUTRAL,
  };
}

async function get(hub, { settings, language }) {
  const lang = language ?? hub.config?.language ?? 'en';
  const show = Object.values(SHOW).includes(settings?.show) ? settings.show : SHOW.ALL;
  if (!hub.client) {
    return message(
      hub.config?.invalidUrl ? CONNECTION_TEXT.invalidUrl : CONNECTION_TEXT.notConfigured,
      lang,
    );
  }
  if (!hub.local) {
    return message(ERROR_TEXT[hub.error?.kind ?? 'unreachable'], lang, 30);
  }
  const folders = [...hub.folders.values()];
  const peers = [...hub.peers.values()];
  if (folders.length === 0 && peers.length === 0) {
    return message(TEXT.empty, lang);
  }

  const components = [];
  const statuses = folders.map((folder) => folderState(folder));
  if (show !== SHOW.DEVICES && folders.length > 0) {
    const upToDate = statuses.filter((s) => s === FOLDER_STATES.UP_TO_DATE).length;
    const failing = statuses.some((s) => s === FOLDER_STATES.ERROR);
    components.push({
      type: 'value',
      value: `${upToDate}/${folders.length}`,
      label: t(TEXT.folders, lang),
      icon: 'folder',
      color: failing
        ? WIDGET_COLORS.DANGER
        : upToDate === folders.length
          ? WIDGET_COLORS.SUCCESS
          : WIDGET_COLORS.WARNING,
    });
  }
  if (show !== SHOW.FOLDERS && peers.length > 0) {
    const connected = peers.filter((peer) => peer.connected).length;
    components.push({
      type: 'value',
      value: `${connected}/${peers.length}`,
      label: t(TEXT.devices, lang),
      icon: 'monitor',
      color: connected === peers.length ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
    });
    const sum = (key) => peers.reduce((total, peer) => total + (peer[key] ?? 0), 0);
    components.push(rateTile(sum('download'), TEXT.download, 'download', lang));
    components.push(rateTile(sum('upload'), TEXT.upload, 'upload', lang));
  }

  if (hub.error) {
    // Syncthing answered before: the rows below are its last known state.
    components.push({ type: 'text', variant: 'body', text: t(ERROR_TEXT[hub.error.kind], lang) });
  }

  const rows = buildRows(hub, show, lang);
  if (rows.length > 0) {
    const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS - 1) : rows;
    const items = shown.map((row) => ({
      label: fit(row.name, 40),
      value: fit(row.value, 40),
      ...ROW_STYLE[row.kind],
    }));
    if (rows.length > shown.length) {
      items.push({
        label: t(TEXT.more, lang),
        value: `+${rows.length - shown.length}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    components.push({ type: 'status', items });
  }

  if (show !== SHOW.DEVICES && folders.length > 0 && !hub.error) {
    components.push({
      type: 'button',
      label: t(TEXT.rescan, lang),
      icon: 'refresh-cw',
      style: 'secondary',
      action: { key: ACTIONS.RESCAN },
    });
    if (folders.some((folder) => !folder.paused)) {
      components.push({
        type: 'button',
        label: t(TEXT.pause, lang),
        icon: 'pause',
        style: 'secondary',
        action: { key: ACTIONS.PAUSE, confirm: true },
      });
    }
    if (folders.some((folder) => folder.paused)) {
      components.push({
        type: 'button',
        label: t(TEXT.resume, lang),
        icon: 'play',
        style: 'secondary',
        action: { key: ACTIONS.RESUME },
      });
    }
  }

  // A sync in progress moves fast: refresh sooner.
  const moving = statuses.some((s) => s === FOLDER_STATES.SYNCING || s === FOLDER_STATES.SCANNING);
  return { ttl_seconds: moving || hub.error ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  const toast = (key, count) => {
    const text = {};
    for (const [lang, entries] of Object.entries(TOAST_TEXT)) {
      text[lang] = entries[key](count);
    }
    return { message: text };
  };
  const folders = hub.targetFolders();
  switch (actionKey) {
    case ACTIONS.RESCAN:
      return toast('rescan', await hub.scanFolders(folders));
    case ACTIONS.PAUSE:
      return toast('pause', await hub.setFoldersPaused(folders, true));
    case ACTIONS.RESUME:
      return toast('resume', await hub.setFoldersPaused(folders, false));
    default:
      throw new Error(`Unknown action ${actionKey}`);
  }
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
