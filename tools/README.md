# Restart tools

Two scripts that restart a DSH host and reopen it in a **visible console window**, so the
replacement's output stays readable instead of vanishing into a hidden process.

This is the other half of the plugin: `dsh-watchdog` wakes a Session *after* a restart, these
restart the host in the first place.

---

## Usage

```bash
# Restart, leaving the replacement's console visible (default 15s grace)
node tools/launch.js

# Give the current turn longer to finish writing its reply
node tools/launch.js --delay 25000
```

`launch.js` starts `restart.js` **outside the host's process tree** (through WMI), waits out
the grace period, stops the host, waits for the port to go quiet, and only then opens the
replacement in a new console window.

### restart.js options

| Option | Default | Meaning |
| --- | --- | --- |
| `--delay <ms>` | `12000` | Wait before stopping the host. Give the current turn time to finish |
| `--port <n>` | `3080` | The port the host serves on |
| `--cwd <dir>` | current | Working directory for the replacement |
| `--args "<list>"` | inherited | Arguments for the replacement, space-separated |
| `--bin <path>` | discovered | The CLI entry to run |
| `--log <file>` | `%TEMP%\dsh-restart.log` | Where the stages are recorded |
| `--hidden` | off | Open the replacement without a console window |

Environment equivalents: `DSH_RESTART_DELAY_MS`, `DSH_RESTART_PORT`, `DSH_RESTART_CWD`,
`DSH_RESTART_ARGS`, `DSH_RESTART_BIN`, `DSH_RESTART_LOG`.

`launch.js --print` shows what would run without running it.

---

## Why a visible window

A hidden console makes a failed start invisible: the process is gone, nothing was printed
anywhere, and the only symptom is a port that never answers. The visible window keeps the
error in front of you, and `restart.js` leaves it open with `pause` when the host exits.

---

## The four things that broke, and what each one taught

Every one of these was measured on a real restart; the numbers are from the log.

### 1. `where dsh` lists the POSIX shim first — 124 seconds

```
launch: C:\…\nodejs\dsh  (source=path)     ← #!/bin/sh script
start → port answers: 124.19s
```

npm installs three shims side by side: `dsh` (a `#!/bin/sh` script), `dsh.cmd`, `dsh.ps1`.
`where` puts the extensionless one first, and handing that to `cmd.exe` means asking it to run
a shell script. It eventually works, two minutes later.

**Fix:** `pickShim()` prefers `.cmd` → `.exe` → `.bat`.

### 2. The npm `.cmd` shim exits immediately in a `start` console

```
window opened … window closed
start → port answers: 47.55s (a host eventually came up, then died)
```

The shim's `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & …` does not survive a
console created by `start`. The window flashes and closes; even `pause` never runs.

**Fix:** don't execute the shim. Parse the path out of it and run `node <bin.js>` directly.

### 3. Direct `node bin.js` is missing the profile argument

```
command: "node.exe" "…\dsh\lib\bin.js"
error: --profile <name> is required
```

The shim forwards its arguments (`%*`); replacing the shim means replacing the arguments too.
Dropping `web` makes the replacement exit before it binds anything.

**Fix:** read the live host's command line, split at `bin.js`, and forward what follows —
`["web"]` — instead of assuming it. (`--args` overrides; `DSH_RESTART_ARGS` does too.)

That split also needed one more step: the command line reads `"…\bin.js" web`, so a naive
split yields `["\"", "web"]` and node receives a stray quote. The closing quote is stripped.

### 4. The helper's own `argv[1]` is not the host entry

The helper is started detached, so its `argv[1]` is `restart.js`. Any "did I boot a DSH host?"
test therefore fails and it falls back to PATH — straight into problems 1 and 2.

**Fix:** `launch.js` reads its *own* `process.argv[1]` (launch.js is started by the host, so
here it *is* the entry) and passes it to the helper as `--bin`.

---

## Result

| Version | How the replacement was started | Start → port answers |
| --- | --- | --- |
| v1 | `dsh` (sh script) | 124.19 s |
| v2 | `dsh.cmd` (npm shim) | 47.55 s, window closed |
| v3 | `node bin.js` | exited: `--profile <name> is required` |
| **v4** | `node bin.js web`, args inherited | **7.14 s** |

7.14 s is inside the normal range for this host (5–10 s).

---

## Tests

```bash
node tools/test-discovery.mjs   # entry discovery: shim choice, resolution, --bin priority
node tools/test-args.mjs        # argument inheritance from a live host
```

Both run without starting or stopping anything.

---

## Limits

- **Windows only.** The detachment relies on WMI (`Win32_Process.Create`), and the whole
  design assumes `start` and a visible console. On other platforms, spawn `restart.js` with
  `detached: true` yourself.
- The argument inheritance reads the live host's command line through PowerShell. If that
  fails it falls back to `["web"]` and says so in the log — check for
  `args: … assuming ["web"]` if a restart behaves unexpectedly.
- `restart.js` reports success only after the port has answered continuously for 8 seconds.
  A host that binds and then dies still counts as a failure.
