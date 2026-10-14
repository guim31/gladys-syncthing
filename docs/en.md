# Syncthing

[Syncthing](https://syncthing.net/) keeps folders in sync between your
computers, phones and NAS, peer to peer, without a cloud. This integration
brings it into Gladys: each folder becomes a device showing whether it is up
to date, its progress and its errors, with a switch to pause it; each remote
device (laptop, phone, other NAS) shows whether it is connected, its transfer
rates and for how long it has been away. Scenes can react when a folder
finishes syncing or fails, and a dashboard widget sums it all up.

Tested against real Syncthing 1.30.0, 2.0.10 and 2.1.6 (two linked
instances); not yet in every setup: feedback welcome on
[the issues](https://github.com/guim31/gladys-syncthing/issues).

## What you need

- Gladys Assistant 5.1.0 or later.
- Syncthing 1.12 or later (tested on 1.30 and 2.x), on a machine Gladys can
  reach on the local network: usually your NAS or home server.
- The API key of that Syncthing.

The integration follows **one** Syncthing: the one on your server. Your other
devices appear as its remote devices, you install nothing on them.

## Getting started

### 1. Prepare Syncthing

In the Syncthing web interface, open **Actions → Settings → GUI**:

- copy the **API Key**;
- set **GUI Listen Address** to `0.0.0.0:8384`. By default Syncthing only
  answers on `127.0.0.1`, which Gladys, in its own container, cannot reach.
  With the interface open to the network, set a **GUI Authentication User**
  and password if not done yet: the API key still works for Gladys.

Syncthing in Docker (linuxserver, official image): publish port 8384 and keep
the listen address of the image (`0.0.0.0:8384`).

### 2. Configure the integration

In Gladys, **Integrations → Syncthing → Configuration**:

- **Syncthing address**: for example `http://192.168.1.10:8384`. A bare IP
  address works too (`http://` and port 8384 are added).
- **API key**: the key of step 1.
- **Accept self-signed certificates**: only for an `https://` address, when
  the interface uses the certificate Syncthing generated itself ("Use HTTPS
  for GUI").
- **Language of the names**: the language of the feature names and of the
  folder states (French by default).

Save, then click **Test the connection**: Syncthing answers with its version,
its folders and its remote devices.

### 3. Add the folders and devices

Open the **Discover** tab: every folder and every remote device of Syncthing
is proposed. Add the ones you want to see in Gladys; nothing is added on your
behalf. A folder or device added later in Syncthing appears there by itself.

## The device of each folder

| Feature          | Value                                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| State            | Up to date, Syncing, Scanning, Out of sync, Error, Paused               |
| Up to date       | On when the folder has everything, Off otherwise (nothing while paused) |
| Progress         | The share of the folder this Syncthing holds, in percent                |
| Left to receive  | What is still to download, in megabytes                                 |
| Failed items     | The files Syncthing could not sync ("Failed Items" in its interface)    |
| Last file synced | The last file received (marked "(deleted)" for a deletion)              |
| Paused           | A switch: on pauses the folder in Syncthing, off resumes it             |

"Out of sync" means the folder lacks something but nothing is coming: the
device that has it is offline. "Error" covers both a folder stopped on an
error (a missing folder marker, a full disk) and failed items.

While a sync runs, the progress, the megabytes left and the last file are
sent to Gladys at most every 30 seconds, their last value always: a large sync
stays far below the 300 values per minute Gladys accepts.

## The device of each remote device

| Feature     | Value                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| Connected   | On while the device is connected to your Syncthing                        |
| Paused      | A switch: on pauses the device in Syncthing (no exchange), off resumes it |
| Download    | What your Syncthing receives from it, in kB/s                             |
| Upload      | What your Syncthing sends to it, in kB/s                                  |
| Offline for | Hours since it was last seen (0 while connected)                          |

"Offline for" is a number: a scene trigger on that device "above 24" answers
"my laptop has not synced for a day" without anything else.

## Dashboard

Add the **Syncthing** widget to a dashboard. It shows:

- the **folders up to date** (for example `2/3`, red when one is in error);
- the **devices connected**, and the total **Download** and **Upload** rates;
- one row per folder and per remote device, the problems first: folders in
  error, out of sync, devices offline (since how long), then syncing (with the
  percentage), paused, up to date — ten rows at most, then the count of the
  others;
- three buttons: **Rescan** (every folder), **Pause all** (asks to confirm)
  and **Resume all**, depending on the state of the folders.

The widget shows every folder and device of Syncthing, added to Gladys or
not. In its settings, **Show** keeps folders only or devices only.

## Scenes

### Triggers

They fire for every folder, added to Gladys or not. Leave **Folder** empty to
react to any of them, or choose one.

- **Folder synced**: a folder received what it was missing and is up to date
  again. Only a real transfer counts: scans and index updates never fire it.
  Variables: folder name, files received.
- **Sync error**: a folder stopped on an error, or some of its files failed to
  sync. Once per problem: Syncthing retries every minute, the trigger does not
  repeat until the folder is clean again. Variables: folder name, failed
  items, error message (the reason of Syncthing, with the file).

The first reading after a start only takes note: a folder already failing
when Gladys starts fires nothing.

### Actions

- **Pause folders**: pauses one folder, or every folder when **Folder** is
  empty. Result: the number of folders paused.
- **Resume folders**: resumes one paused folder, or every one. Result: the
  number of folders resumed.
- **Rescan folders**: asks Syncthing to look for changes now, in one folder or
  every one (a long scan carries on after the action). Result: the number of
  folders rescanned.

Nothing here deletes anything: a paused folder keeps its files and resumes
where it stopped.

### Scene ideas

- **Photos backed up**: trigger "Folder synced" on the Photos folder → send a
  message "📷 … photos received on the NAS", inserting "Files received".
- **Something is wrong**: trigger "Sync error" (Folder empty) → send a message
  "⚠️ … : …" with "Folder name" and "Error message".
- **Video call in peace**: a scene started from a dashboard button → "Pause
  folders" (Folder empty); a second one, or a delay of one hour → "Resume
  folders".
- **Laptop forgotten**: trigger on the device "laptop", feature "Offline for",
  above 72 → send a message "The laptop has not synced for three days".

## How the integration reads Syncthing

- **Live**: the event API of Syncthing (`/rest/events`, a request held open
  until something happens) brings the folder states, the progress, the files
  received, the errors, the pauses and the devices connecting or leaving.
- **Every 30 seconds**: the connections (for the transfer rates, which no
  event carries) and when each device was last seen.
- **Every 5 minutes**, and after a change in the configuration of Syncthing:
  everything again, as a safety net. The summary of a folder is the one call
  the documentation of Syncthing calls expensive on large folders: it is read
  that rarely. If the event API does not work (a proxy that cuts long
  requests), everything is read every 30 seconds instead.

Syncthing sets no request quota on its API. The integration only writes when
you ask: pause, resume, rescan.

## Troubleshooting

- **"Syncthing does not answer"**: check the address and the port from the
  Gladys machine, and that the GUI listen address is `0.0.0.0:8384` (step 1).
  `localhost` is the integration container itself: use the IP address of the
  machine running Syncthing.
- **"API key refused"**: copy the key again from Actions → Settings → GUI (it
  changes when you click "Generate").
- **"Syncthing refuses this host name"**: the interface listens on
  `127.0.0.1` behind a reverse proxy: use the IP address, or open the
  interface on `0.0.0.0`.
- **"Certificate refused"**: the interface uses HTTPS with its own
  certificate; tick "Accept self-signed certificates".
- **"The address redirects"**: the interface is in HTTPS: type `https://`.
- **"No Syncthing at this address"**: another service answers on that port.
- **A folder stays "Out of sync"**: the device holding the missing files is
  offline; it catches up when it comes back.
- **"Test the connection" says the live updates are unavailable**: a proxy
  between Gladys and Syncthing cuts the requests held open; the integration
  still works, refreshed every 30 seconds.

## Limits

- One Syncthing per integration: the one Gladys reaches.
- The progress and the rates are refreshed every 30 seconds at most.
- "Folder synced" fires on the Syncthing that receives the files: on the one
  that sends them (a laptop sending its photos to the NAS), it does not fire.
- Ignore patterns, versioning, conflicts and the sharing of folders stay in
  the Syncthing interface; the integration never deletes a file.
- Gladys freezes the feature names at creation: changing the language later
  only changes the folder states and the newly added devices.
