# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-14

### Added

- Follow a Syncthing (1.12 or later, tested on 1.30 and 2.x) from Gladys,
  through its local REST API and API key.
- One device per folder: state, up to date, progress, megabytes left to
  receive, failed items, last file synced, and a "Paused" switch that pauses
  and resumes the folder.
- One device per remote device: connected, a "Paused" switch, download and
  upload rates, hours offline.
- Live updates through the event API of Syncthing, a refresh of the rates
  every 30 seconds and a full reading every 5 minutes, without relying on the
  polling of Gladys.
- Scene triggers "Folder synced" and "Sync error", for every folder.
- Scene actions "Pause folders", "Resume folders" and "Rescan folders".
- Dashboard widget "Syncthing": folders and devices with their state,
  transfer rates, Rescan, Pause all and Resume all buttons.
- "Test the connection" button and a connection status saying what is wrong.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-syncthing/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-syncthing/releases/tag/v1.0.1
