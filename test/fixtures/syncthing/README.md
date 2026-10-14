# Recorded Syncthing answers

Real answers of Syncthing, recorded on 14/10/2026 from two instances started
in a coding session and linked to each other:

- `v2.1.6/`: Syncthing 2.1.6, the "nas", sharing `Photos` (`photos-x7k2`,
  send & receive) and `Documents` (`docs`, send only) with the "laptop";
- `v1.30.0/`: Syncthing 1.30.0, the "laptop": the same two folders
  (`docs` receive only) and an unshared `Default Folder`.

What each file is:

| File                                 | Request, or what happened                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `system-status.json`                 | `GET /rest/system/status` (connection and discovery details cut)                                  |
| `system-version.json`                | `GET /rest/system/version`                                                                        |
| `config-folders.json`                | `GET /rest/config/folders`                                                                        |
| `config-devices.json`                | `GET /rest/config/devices`                                                                        |
| `db-status-*.json`                   | `GET /rest/db/status`: idle, syncing (85 %), with a failed item                                   |
| `folder-errors.json`                 | `GET /rest/folder/errors` with that failed item                                                   |
| `stats-folder.json`, `stats-device*` | `GET /rest/stats/folder`, `/rest/stats/device`                                                    |
| `system-connections*.json`           | `GET /rest/system/connections`, 10 s apart during a transfer, and with the other instance stopped |
| `events-sync.json`                   | a 30 MB file received at 2 MB/s, from `sync-waiting` to `idle`                                    |
| `events-first-sync.json`             | the first sync of four files                                                                      |
| `events-failed.json`                 | a file that cannot be written (immutable directory): failed item                                  |
| `events-recovered.json`              | the retry a minute later, once the directory was writable again                                   |
| `events-folder-error.json`           | the `.stfolder` marker removed then put back: folder error                                        |
| `events-pause.json`                  | a folder paused and resumed, then the device paused and resumed                                   |
| `events-device-restart.json`         | the other instance stopped and started again                                                      |

The events are those of the list the integration subscribes to
(`EVENT_TYPES` of `src/syncthing/client.js`), with their recorded ids.

Anonymized: the device IDs are the example IDs of the Syncthing
documentation, the addresses are in `192.0.2.0/24`, the paths and host names
are invented. The data of the `ConfigSaved` events, which holds the whole
configuration of Syncthing (API key included), is cut down to its version.
