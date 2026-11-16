### Added
- A machine profile, as a preview: `OVIS_PROFILE=machine` beside `OVIS_PREVIEW=fleet` starts
  `ovis-server serve` next to an existing classic herdr, on loopback only, with its own relay
  identity and a state folder of its own (`OVIS_STATE_DIR`). Its pairing gate is closed from the
  first start, a Tailscale identity header lets nobody in, and engine updates, runtime changes,
  Portal, LAN HTTPS and direct connections are unavailable in it. Its TCP port answers only that
  it is alive, and `OVIS_TOKEN` is ignored there; its owner reaches it on the unix socket
  `serve.sock` in its state folder, which only that account can open. It does not start on Windows.
  Without `OVIS_PREVIEW=fleet` it says what to set and exits before it touches its state folder.
  The machine profile stays a preview.

### Changed
- `ovis-server serve` holds a lock file `serve.own` in its state folder while it runs (not on
  Windows, where no machine profile runs), so that a machine profile does not start on a state
  folder an ordinary server holds, nor an ordinary server on one a profile holds. Two ordinary
  servers share a folder as before.
