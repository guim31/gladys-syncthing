// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, folder and
// device states (feature values, widget rows), scene action errors. Four
// languages, the four of the Gladys interface; German says "du", Spanish
// "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './syncthing/client.js';
import { FOLDER_STATES } from './syncthing/model.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  notConfigured: {
    en: 'Enter the address and the API key of your Syncthing in the configuration.',
    fr: "Saisissez l'adresse et la clé d'API de votre Syncthing dans la configuration.",
    de: 'Gib die Adresse und den API-Schlüssel deines Syncthing in der Konfiguration ein.',
    es: 'Introduzca la dirección y la clave API de su Syncthing en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.10:8384',
    fr: 'Adresse incomprise, ex. http://192.168.1.10:8384',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.10:8384',
    es: 'Dirección no válida, p. ej. http://192.168.1.10:8384',
  },
};

// One short explanation per error kind (src/syncthing/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'Syncthing does not answer: is its interface listening on 0.0.0.0:8384?',
    fr: 'Syncthing ne répond pas : son interface écoute-t-elle sur 0.0.0.0:8384 ?',
    de: 'Syncthing antwortet nicht: Lauscht seine Oberfläche auf 0.0.0.0:8384?',
    es: 'Syncthing no responde: ¿su interfaz escucha en 0.0.0.0:8384?',
  },
  [ERROR_KINDS.TLS]: {
    en: 'Certificate refused: tick "Accept self-signed certificates"',
    fr: 'Certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'Certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'API key refused: copy it again from Actions → Settings → GUI',
    fr: "Clé d'API refusée : recopiez-la depuis Actions → Configuration → GUI",
    de: 'API-Schlüssel abgelehnt: Kopiere ihn erneut unter Aktionen → Einstellungen → GUI',
    es: 'Clave API rechazada: cópiela de nuevo desde Acciones → Ajustes → GUI',
  },
  [ERROR_KINDS.HOST_CHECK]: {
    en: 'Syncthing refuses this host name: use its IP address',
    fr: "Syncthing refuse ce nom d'hôte : utilisez son adresse IP",
    de: 'Syncthing lehnt diesen Hostnamen ab: Verwende seine IP-Adresse',
    es: 'Syncthing rechaza este nombre de host: utilice su dirección IP',
  },
  [ERROR_KINDS.NOT_SYNCTHING]: {
    en: 'No Syncthing at this address',
    fr: 'Aucun Syncthing à cette adresse',
    de: 'Kein Syncthing unter dieser Adresse',
    es: 'No hay ningún Syncthing en esta dirección',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'The address redirects: enter the https:// address',
    fr: "L'adresse redirige : saisissez l'adresse en https://",
    de: 'Die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'La dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'Unexpected answer, see the logs',
    fr: 'Réponse inattendue, voir les logs',
    de: 'Unerwartete Antwort, sieh in den Protokollen nach',
    es: 'Respuesta inesperada, consulte los registros',
  },
};

// The state of a folder, in words: the value of its "State" feature, the
// widget rows, the scene outputs.
export const FOLDER_STATE_TEXT = {
  [FOLDER_STATES.UP_TO_DATE]: { en: 'Up to date', fr: 'À jour', de: 'Aktuell', es: 'Actualizado' },
  [FOLDER_STATES.SYNCING]: {
    en: 'Syncing',
    fr: 'Synchronisation',
    de: 'Synchronisiert',
    es: 'Sincronizando',
  },
  [FOLDER_STATES.SCANNING]: { en: 'Scanning', fr: 'Analyse', de: 'Scannt', es: 'Analizando' },
  [FOLDER_STATES.OUT_OF_SYNC]: {
    en: 'Out of sync',
    fr: 'Désynchronisé',
    de: 'Nicht synchron',
    es: 'No sincronizado',
  },
  [FOLDER_STATES.ERROR]: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  [FOLDER_STATES.PAUSED]: { en: 'Paused', fr: 'En pause', de: 'Pausiert', es: 'En pausa' },
  [FOLDER_STATES.UNKNOWN]: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
};

// The state of a remote device, in words (widget rows).
export const DEVICE_STATE_TEXT = {
  connected: { en: 'Connected', fr: 'Connecté', de: 'Verbunden', es: 'Conectado' },
  disconnected: { en: 'Disconnected', fr: 'Déconnecté', de: 'Getrennt', es: 'Desconectado' },
  paused: { en: 'Paused', fr: 'En pause', de: 'Pausiert', es: 'En pausa' },
  never: { en: 'Never seen', fr: 'Jamais vu', de: 'Nie gesehen', es: 'Nunca visto' },
};

// "Offline for 3 h", "Offline for 2 d" (widget rows).
export const OFFLINE_TEXT = {
  en: { hours: (n) => `Offline for ${n} h`, days: (n) => `Offline for ${n} d` },
  fr: { hours: (n) => `Hors ligne depuis ${n} h`, days: (n) => `Hors ligne depuis ${n} j` },
  de: { hours: (n) => `Seit ${n} Std. offline`, days: (n) => `Seit ${n} T. offline` },
  es: { hours: (n) => `Desconectado hace ${n} h`, days: (n) => `Desconectado hace ${n} d` },
};

// Appended to the last file when it was a deletion.
export const DELETED_TEXT = {
  en: '(deleted)',
  fr: '(supprimé)',
  de: '(gelöscht)',
  es: '(eliminado)',
};

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: (version) => `Connected to Syncthing ${version}`,
    folders: (count, upToDate) => `${count} folder(s), ${upToDate} up to date`,
    devices: (count, connected) => `${count} remote device(s), ${connected} connected`,
    noEvents: 'live updates unavailable: refreshed every 30 s',
  },
  fr: {
    ok: (version) => `Connecté à Syncthing ${version}`,
    folders: (count, upToDate) => `${count} dossier(s), ${upToDate} à jour`,
    devices: (count, connected) => `${count} appareil(s) distant(s), ${connected} connecté(s)`,
    noEvents: 'suivi en direct indisponible : relecture toutes les 30 s',
  },
  de: {
    ok: (version) => `Verbunden mit Syncthing ${version}`,
    folders: (count, upToDate) => `${count} Ordner, ${upToDate} aktuell`,
    devices: (count, connected) => `${count} entfernte(s) Gerät(e), ${connected} verbunden`,
    noEvents: 'Live-Verfolgung nicht verfügbar: alle 30 s neu gelesen',
  },
  es: {
    ok: (version) => `Conectado a Syncthing ${version}`,
    folders: (count, upToDate) => `${count} carpeta(s), ${upToDate} actualizada(s)`,
    devices: (count, connected) => `${count} dispositivo(s) remoto(s), ${connected} conectado(s)`,
    noEvents: 'seguimiento en directo no disponible: lectura cada 30 s',
  },
};

// Errors of the scene actions and of the commands (shown in Gladys).
export const ACTION_TEXT = {
  notConfigured: {
    en: 'Syncthing is not configured.',
    fr: "Syncthing n'est pas configuré.",
    de: 'Syncthing ist nicht konfiguriert.',
    es: 'Syncthing no está configurado.',
  },
  unknownFolder: {
    en: 'This device is not a Syncthing folder.',
    fr: "Cet appareil n'est pas un dossier Syncthing.",
    de: 'Dieses Gerät ist kein Syncthing-Ordner.',
    es: 'Este dispositivo no es una carpeta de Syncthing.',
  },
  unknownDevice: {
    en: 'This folder or device no longer exists in Syncthing.',
    fr: "Ce dossier ou cet appareil n'existe plus dans Syncthing.",
    de: 'Dieser Ordner oder dieses Gerät existiert in Syncthing nicht mehr.',
    es: 'Esta carpeta o este dispositivo ya no existe en Syncthing.',
  },
  noFolder: {
    en: 'No folder in Syncthing.',
    fr: 'Aucun dossier dans Syncthing.',
    de: 'Kein Ordner in Syncthing.',
    es: 'No hay ninguna carpeta en Syncthing.',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
