# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the API key of Syncthing is a `secret` field of the Gladys
  configuration. The integration reads it from Gladys at startup, keeps it in
  memory, sends it only to the Syncthing address typed in the configuration
  (`X-API-Key` header), and never writes it to `/data` nor to the logs. The
  `ConfigSaved` events of Syncthing carry its whole configuration, API key
  included: their data is never logged nor kept.
- **Stored in `/data`**: nothing. The state of the folders and devices is read
  again from Syncthing at every start.
- **What the key allows**: the key of the Syncthing interface gives full
  control of Syncthing. The integration only reads, and writes on a user's
  request what is reversible: pause or resume a folder or a device, ask for a
  rescan. It never deletes a file, a folder or a device.
- **Network**: requests go only to the Syncthing address of the
  configuration, in HTTP or HTTPS. HTTPS certificates are verified unless the
  user ticks "Accept self-signed certificates"; an address carrying a user
  name or password is refused. The integration opens no port and calls no
  cloud service.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
Syncthing itself (see its
[security policy](https://github.com/syncthing/syncthing/security/policy)),
and the devices it synchronizes with.
