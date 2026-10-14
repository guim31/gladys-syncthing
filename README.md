# Syncthing for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that
brings [Syncthing](https://syncthing.net/), the peer-to-peer file
synchronization tool, into Gladys: one device per folder and per remote
device, live through the event API of Syncthing, scenes that react when a
folder finishes syncing or fails, and a dashboard widget. It talks to the REST
API of the Syncthing running on your NAS or home server, with its API key,
over the local network. No cloud, no account.

> Tested against real Syncthing 1.30.0, 2.0.10 and 2.1.6 (two linked
> instances started for the tests), not yet in a real Gladys: feedback welcome
> in the [issues](https://github.com/guim31/gladys-syncthing/issues).

## Features

- **One device per folder**, proposed in the Discover tab (the user adds the
  ones to follow): **State** (Up to date, Syncing, Scanning, Out of sync,
  Error, Paused), **Up to date** (on/off), **Progress** (%), **Left to
  receive** (MB), **Failed items**, **Last file synced**, and a **Paused**
  switch that pauses and resumes the folder in Syncthing.
- **One device per remote device** (laptop, phone, other NAS): **Connected**,
  a **Paused** switch, **Download** and **Upload** rates (kB/s) and **Offline
  for** (hours since last seen, for a scene "not synced for a day").
- **Live**: the event API of Syncthing (long poll) brings folder states,
  progress, files received, errors, pauses and connections as they happen; a
  30 s timer of the container reads the transfer rates; a full reading every
  5 minutes is the safety net.
- **Scene triggers**, for every folder, added to Gladys or not: _Folder
  synced_ (a real transfer ended, with the number of files received) and
  _Sync error_ (a folder stopped on an error or failed items, once per
  problem, with the reason given by Syncthing).
- **Scene actions**: _Pause folders_, _Resume folders_, _Rescan folders_ —
  one folder or all of them (a video call, a metered connection, after a
  backup).
- **Dashboard widget** "Syncthing": folders up to date, devices connected,
  total rates, one row per folder and device (problems first), and **Rescan**,
  **Pause all** / **Resume all** buttons.
- A **Test the connection** button, a connection status that says what is
  wrong (address, key, certificate, host check), a **transport badge** per
  device. Every text in English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.1.0** or later (widgets, scene triggers and actions).
- **Syncthing 1.12 or later** (tested on 1.30 and 2.x), its web interface
  reachable from the Gladys machine: set the GUI listen address to
  `0.0.0.0:8384` (Actions → Settings → GUI), Syncthing answers on `127.0.0.1`
  only by default.
- The **API key** of Syncthing (same screen).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-syncthing`
   (or install **Syncthing** from the catalog once it is listed).
2. In **Configuration**, enter the address of Syncthing
   (`http://192.168.1.10:8384`) and its API key. Save, then click **Test the
   connection**.
3. Open the **Discover** tab and add the folders and devices to follow.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- `GET /rest/events` (long poll, a fixed list of event types): `StateChanged`,
  `FolderSummary`, `FolderErrors`, `ItemFinished`, `FolderPaused` /
  `FolderResumed`, `DeviceConnected` / `DeviceDisconnected`, `DevicePaused` /
  `DeviceResumed`, `ConfigSaved` (whose data, the whole configuration with the
  API key, is never logged nor kept).
- Every 30 s: `/rest/system/connections` (rates from two readings) and
  `/rest/stats/device` (last seen).
- At start, after `ConfigSaved` and every 5 minutes: the configuration
  (`/rest/config/folders`, `/rest/config/devices`), `/rest/db/status` of each
  folder (the call Syncthing documents as expensive), `/rest/stats/folder`. If
  the event API does not work, this full reading runs every 30 s instead.
- Writes, only on a user's request: `PATCH /rest/config/folders/<id>` and
  `/rest/config/devices/<id>` (`paused`), `POST /rest/db/scan`.
- The devices are published with `should_poll: false`: the core never polls
  them ([Gladys#3198](https://github.com/GladysAssistant/Gladys/issues/3198)).
  Only the values that changed are sent (deduplication of the SDK), a moving
  value at most every 30 s, and every value again every 12 h.

## Checked on a real Syncthing, and what was not

`npm run test:real` starts two real Syncthing instances in temporary
directories (127.0.0.1 only, discovery and relays off), links them, shares a
folder, and drives the integration against the first one: discovery, a live
sync ending in _Folder synced_, the **Paused** switch, a folder error ending in
_Sync error_ and its recovery, the scene action, the widget, a device going
away, Syncthing going down. It passes with Syncthing 2.1.6 followed and 1.30.0
on the other side, the reverse, and 2.0.10 with 2.1.6. The answers and event
sequences used by the unit tests were recorded on those instances
([`test/fixtures/syncthing/`](test/fixtures/syncthing/README.md)).

Not checked: a real Gladys (the Discovery tab, the widget and the scene
editor rendering), Syncthing behind a reverse proxy, an HTTPS interface with
its self-signed certificate, Syncthing on Windows or Android.

## Limitations

- One Syncthing per integration.
- Progress and rates are refreshed every 30 s at most.
- _Folder synced_ fires on the Syncthing that receives the files, not on the
  one that sends them.
- Ignore patterns, versioning, conflicts and folder sharing stay in Syncthing;
  the integration never deletes a file.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
SYNCTHING_BIN=/path/to/syncthing npm run test:real   # optional, real Syncthing
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and an in-memory Syncthing (`test/helpers/fakeSyncthing.js`) answering what
real Syncthing 1.30.0 and 2.1.6 answered. See [`CLAUDE.md`](CLAUDE.md) for the
project rules.

Releases go through **Actions → Release** (see `.github/workflows/release.yml`):
it bumps `package.json` and the manifest `version` and `docker_image`
together, moves the `## [Unreleased]` section of [`CHANGELOG.md`](CHANGELOG.md)
and builds the image. Pushing a `vX.Y.Z` tag by hand also builds it, but
then bump those three by hand first, in one commit.

## Credits

- [Syncthing](https://github.com/syncthing/syncthing) by the Syncthing
  Foundation and contributors (MPL-2.0): its
  [REST API](https://docs.syncthing.net/dev/rest.html) and
  [event API](https://docs.syncthing.net/dev/events.html), and the folder
  states of `lib/model/folderstate.go`.
- Home Assistant's
  [`syncthing`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/syncthing)
  integration (Apache-2.0) and its library
  [aiosyncthing](https://github.com/zhulik/aiosyncthing) by Gleb Sinyavskiy
  (MIT): the event-driven design (`FolderSummary`, `StateChanged`,
  `FolderPaused`) and the reconnection loop.
- The architecture and the conformity tests follow
  [gladys-uptime-kuma](https://github.com/guim31/gladys-uptime-kuma),
  [gladys-pihole](https://github.com/guim31/gladys-pihole),
  [gladys-subsonic](https://github.com/guim31/gladys-subsonic) and
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Syncthing or the
Syncthing Foundation.

## License

Apache-2.0
