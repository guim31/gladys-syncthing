// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Syncthing per integration: the one Gladys can reach, usually on the NAS
// or the server that also runs Gladys. Its other devices (laptops, phones)
// appear as remote devices of that Syncthing.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const DEFAULT_CONFIG = {
  url: '',
  api_key: '',
  allow_self_signed: false,
  language: 'fr',
};

// The port of the Syncthing web interface, added to an address typed without
// scheme nor port ("192.168.1.10").
export const DEFAULT_PORT = 8384;

/**
 * Parse the address typed by the user into a base URL: a bare host or IP
 * (`192.0.2.10`, `nas.local:8384`), or the URL copied from the browser
 * (`https://192.0.2.10:8384/#settings-gui`). HTTP and port 8384 by default.
 * A path is kept (Syncthing behind a reverse proxy sub-path).
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port][/path]`, null when unusable
 */
export function parseSyncthingUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs and the messages.
  if (url.username || url.password) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(DEFAULT_PORT);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Host part shown to the user (no scheme). */
export const hostOf = (url) => url.replace(/^https?:\/\//, '');

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 * @returns {{ url: string|null, invalidUrl: boolean, apiKey: string,
 *   allowSelfSigned: boolean, language: string }}
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const typed = text('url');
  const url = parseSyncthingUrl(typed);
  return {
    url,
    invalidUrl: typed !== '' && url === null,
    // A pasted key often carries a trailing space or new line.
    apiKey: text('api_key'),
    allowSelfSigned: source.allow_self_signed === true || source.allow_self_signed === 'true',
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

/** Both the address and the API key are there: Syncthing can be asked. */
export const isConfigured = (config) => Boolean(config?.url && config.apiKey);
