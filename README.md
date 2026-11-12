# dsh-watchdog

Boot-time session waker for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

When you restart the DSH host, a conversation you were working in stops — and you have to go
find it and type something to get it going again. `dsh-watchdog` closes that gap: an agent
registers its own Session, and after the next host boot the plugin delivers one wake-up message
to it, then unregisters it.

## What it does

```
agent calls dsh_watchdog_arm
  → its Session is written to a persisted wake list, tagged with the current boot id
    → host restarts (boot id changes)
      → the new host delivers a wake-up message to each listed Session
        → successful delivery removes it from the list
```

The message arrives as an ordinary user-role message, so the Session starts a normal turn.

## Why a boot id

A wake list entry only means "wake me after a restart". Without that distinction, an entry made
during one boot gets delivered a few seconds later **in the same boot**, consuming the entry
before the restart it was armed for. Each entry therefore records the `bootId` it was created
under, and only entries from a *previous* boot are delivered.

This makes the behaviour easy to reason about:

| Entry created | Delivered |
| --- | --- |
| During the current boot | Not now — after the next restart |
| During a previous boot | On this boot, after `delaySeconds` |

`dsh_watchdog_list` reports both groups separately.

## Tools

| Tool | Purpose |
| --- | --- |
| `dsh_watchdog_arm` | Add the current Session (or a named one) to the wake list, with optional custom text |
| `dsh_watchdog_disarm` | Remove a Session from the wake list |
| `dsh_watchdog_list` | Show both groups plus instance state |
| `dsh_watchdog_status` | Compact status summary |
| `dsh_watchdog_stop` | Stop this instance's deliveries (does **not** clear the wake list) |

`sessionId` defaults to the calling Session.

## Install

```bash
dsh plugin --profile <profile> add dsh-watchdog
```

Or from a local checkout:

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-watchdog
```

## Configure

Override the plugin row in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-watchdog
  name: dsh-watchdog
  config:
    enabled: true
    delaySeconds: 30
    intervalSeconds: 60
    maxAttempts: 5
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When off, nothing is read and nothing is delivered |
| `delaySeconds` | `30` | Wait after host boot before the first round |
| `intervalSeconds` | `60` | Retry interval for failed entries. Clamped to 60s — the host's minimum delivery spacing |
| `maxAttempts` | `5` | Attempts per entry before giving up and removing it |
| `defaultContent` | `''` | Wake-up text when an entry carries none |
| `stateDir` | `$DSH_HOME/dsh-watchdog` | Where `registry.json` and `watchdog.log` live |

`intervalSeconds` governs **retries only**. A successful delivery ends that entry; there is no
repeating reminder.

## State and logs

```
$DSH_HOME/dsh-watchdog/registry.json   # the wake list
$DSH_HOME/dsh-watchdog/watchdog.log    # append-only diagnostics
```

`registry.json` looks like this:

```json
{
  "sessions": {
    "session-…": {
      "content": "",
      "attempts": 0,
      "addedAt": "2026-01-01T00:00:00.000Z",
      "addedBy": "tool",
      "bootId": "1234-1700000000000"
    }
  }
}
```

A healthy wake produces:

```
[dsh-watchdog] sessionController ready (ok)
[dsh-watchdog] armed run=… boot=… sessions=session-… first=30s maxAttempts=5
[dsh-watchdog] scheduling first round in 30s (1 cross-boot session(s))
[dsh-watchdog] round 1 starting for 1 session(s)
[dsh-watchdog] delivered to session-…
[dsh-watchdog] disarmed session-… reason=delivered (total=0)
[dsh-watchdog] stopped run=… reason=all entries resolved
```

The line to look for is `delivered to`. A `round … starting` with no matching `delivered` means
the delivery failed — the adjacent line carries the reason. The log is append-only and never
rotated; delete it whenever it gets large.

## Implementation notes

Three details matter if you modify this plugin:

1. **Wait for `sessionController` with `ctx.inject`, not `ctx.get`.**
   The service is provided by `@deepseek-ai/dsh-api-session-controller` (registered in the
   `dsh-web-app` bundle, not `base`). A synchronous `ctx.get` during mount returns `undefined`,
   after which every round silently skips — and nothing is delivered.

2. **`resolveAgent` has two return shapes.**
   An inner controller returns `{ agent } | { error }`; an outer one returns the agent directly.
   Accept the object that actually has `followup`, and treat `{ error }` as a failure.

3. **Flush after enqueueing.**
   Call `ctx.sessions.flush()` after `agent.followup()`, matching what the host's own scheduler
   does — otherwise the message can sit in memory and be lost if the host goes down.

## Tests

Offline stub tests with a controllable clock — no host required:

```bash
node test-offline.mjs
```

Covers arm/disarm, cross-boot-only delivery, multi-session delivery, retry-to-give-up,
both `resolveAgent` shapes, empty-list idling, missing-service safety, and the master switch.

## Restarting the host

This plugin wakes a Session *after* a restart; it does not restart anything itself. For the
other half there are two scripts in [`tools/`](tools/README.md):

```bash
node tools/launch.js                  # restart, replacement opens in a visible console
node tools/launch.js --delay 25000    # give the current turn longer to finish
```

They stop the host, wait for the port to be released, reopen the host in a new console window,
and report success only once the port has answered for 8 seconds. Measured end to end:
**7.1 seconds** from start to a serving port.

Windows only — the detachment relies on WMI.

## Known limits

- Delivers only to Sessions that still exist. An archived Session fails to resolve and is
  reported in the log; the plugin will not unarchive it.
- Wake counts are per boot. Each restart re-evaluates the list from scratch.
- `dsh_watchdog_stop` affects the current instance only. To disable it for good, set
  `enabled: false` and restart.

## License

MIT
