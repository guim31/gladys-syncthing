// The model on the real answers of Syncthing 1.30.0 and 2.1.6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLDER_STATES,
  completion,
  deviceName,
  failedItems,
  folderKey,
  folderName,
  folderState,
  parseDate,
  remainingMegabytes,
  shortId,
} from '../src/syncthing/model.js';
import { fixture } from './helpers/fakeSyncthing.js';

const syncing = fixture('v1.30.0/db-status-syncing.json');
const failed = fixture('v1.30.0/db-status-failed.json');
const idle = fixture('v2.1.6/db-status-photos.json');
const empty = fixture('v1.30.0/db-status-default.json');

const state = (summary, extra = {}) =>
  folderState({ paused: false, state: summary.state, summary, ...extra });

test('the state of a folder, from real summaries', () => {
  assert.equal(state(idle), FOLDER_STATES.UP_TO_DATE);
  assert.equal(state(empty), FOLDER_STATES.UP_TO_DATE);
  assert.equal(state(syncing), FOLDER_STATES.SYNCING);
  // Idle with a failed item: what the interface calls "Failed Items".
  assert.equal(failed.state, 'idle');
  assert.equal(state(failed), FOLDER_STATES.ERROR);
  // A paused folder answers an empty state.
  assert.equal(state({ ...idle, state: '' }), FOLDER_STATES.PAUSED);
  assert.equal(state(idle, { paused: true }), FOLDER_STATES.PAUSED);
});

test('every raw state of Syncthing has a meaning', () => {
  const cases = {
    idle: FOLDER_STATES.UP_TO_DATE,
    scanning: FOLDER_STATES.SCANNING,
    'scan-waiting': FOLDER_STATES.SCANNING,
    starting: FOLDER_STATES.SCANNING,
    syncing: FOLDER_STATES.SYNCING,
    'sync-waiting': FOLDER_STATES.SYNCING,
    'sync-preparing': FOLDER_STATES.SYNCING,
    cleaning: FOLDER_STATES.SYNCING,
    'clean-waiting': FOLDER_STATES.SYNCING,
    error: FOLDER_STATES.ERROR,
    something_new: FOLDER_STATES.UNKNOWN,
  };
  for (const [raw, expected] of Object.entries(cases)) {
    assert.equal(folderState({ paused: false, state: raw, summary: empty }), expected, raw);
  }
  // Idle while something is still needed (the device holding it is away).
  assert.equal(
    folderState({ paused: false, state: 'idle', summary: { ...idle, needBytes: 10 } }),
    FOLDER_STATES.OUT_OF_SYNC,
  );
});

test('progress and remaining megabytes', () => {
  // 91 000 264 bytes, 13 624 454 still needed.
  assert.equal(syncing.globalBytes, 91000264);
  assert.equal(completion(syncing), 85);
  assert.equal(remainingMegabytes(syncing), 13.6);
  assert.equal(completion(idle), 100);
  assert.equal(remainingMegabytes(idle), 0);
  assert.equal(completion(empty), 100, 'an empty folder is complete');
  // 2 bytes missing out of 61 MB: not 100 % yet.
  assert.equal(completion({ globalBytes: 61000264, needBytes: 2, needTotalItems: 1 }), 99);
  assert.equal(completion({ globalBytes: 0, needBytes: 0, needTotalItems: 3 }), 100);
  assert.equal(completion(null), null);
  assert.equal(failedItems(failed), 1);
  assert.equal(failedItems(idle), 0);
});

test('identities and names', () => {
  assert.equal(
    shortId('P56IOI7-MZJNU2Y-IQGDREY-DM2MGTI-MGL3BXN-PQ6W5BM-TBBZ4TJ-XZWICQ2'),
    'P56IOI7',
  );
  assert.equal(folderKey('photos-x7k2'), 'photos-x7k2');
  assert.equal(folderKey('default'), 'default');
  const odd = folderKey('My Photos: 2026');
  assert.match(odd, /^h[0-9a-f]{16}$/);
  assert.equal(folderKey('My Photos: 2026'), odd, 'stable');
  assert.notEqual(folderKey('My Photos: 2025'), odd);
  assert.equal(folderName({ id: 'abcd-1234', label: '' }), 'abcd-1234');
  assert.equal(folderName({ id: 'abcd-1234', label: ' Photos ' }), 'Photos');
  assert.equal(deviceName({ deviceID: 'P56IOI7-MZJNU2Y', name: '' }), 'P56IOI7');
});

test('the dates Syncthing uses for "never" are null', () => {
  const stats = fixture('v2.1.6/stats-device.json');
  const dates = Object.values(stats).map((entry) => parseDate(entry.lastSeen));
  assert.ok(dates.includes(null), 'this Syncthing itself: 1970-01-01');
  assert.ok(dates.some((date) => date !== null));
  assert.equal(parseDate('0001-01-01T00:00:00Z'), null);
  assert.equal(parseDate(undefined), null);
});
