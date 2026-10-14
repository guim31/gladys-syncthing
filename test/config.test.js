import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, parseSyncthingUrl } from '../src/config.js';

test('an address typed without scheme nor port gets http:// and port 8384', () => {
  assert.equal(parseSyncthingUrl('192.0.2.10'), 'http://192.0.2.10:8384');
  assert.equal(parseSyncthingUrl(' nas.local:8385 '), 'http://nas.local:8385');
  assert.equal(parseSyncthingUrl('[2001:db8::1]'), 'http://[2001:db8::1]:8384');
});

test('a full URL is kept as typed, the interface page dropped', () => {
  assert.equal(
    parseSyncthingUrl('https://192.0.2.10:8384/#settings-gui'),
    'https://192.0.2.10:8384',
  );
  assert.equal(parseSyncthingUrl('https://sync.example.com/'), 'https://sync.example.com');
  // Behind a reverse proxy, on a sub-path.
  assert.equal(
    parseSyncthingUrl('https://home.example.com/syncthing/'),
    'https://home.example.com/syncthing',
  );
});

test('unusable addresses are refused, credentials included', () => {
  for (const raw of ['', '   ', 'ftp://nas', 'http://', 'https://user:pass@nas:8384', 42, null]) {
    assert.equal(parseSyncthingUrl(raw), null, String(raw));
  }
});

test('the configuration is normalized', () => {
  assert.deepEqual(normalizeConfig(), {
    url: null,
    invalidUrl: false,
    apiKey: '',
    allowSelfSigned: false,
    language: 'fr',
  });
  const config = normalizeConfig({
    url: '192.0.2.10',
    api_key: ' key-with-a-new-line\n',
    allow_self_signed: 'true',
    language: 'de',
  });
  assert.deepEqual(config, {
    url: 'http://192.0.2.10:8384',
    invalidUrl: false,
    apiKey: 'key-with-a-new-line',
    allowSelfSigned: true,
    language: 'de',
  });
  assert.equal(isConfigured(config), true);
  assert.equal(normalizeConfig({ url: 'ftp://x' }).invalidUrl, true);
  assert.equal(normalizeConfig({ language: 'it' }).language, DEFAULT_CONFIG.language);
  assert.equal(isConfigured(normalizeConfig({ url: '192.0.2.10' })), false, 'no key');
});
