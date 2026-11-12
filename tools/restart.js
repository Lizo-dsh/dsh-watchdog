#!/usr/bin/env node
/**
 * restart.js — restart a DSH host, opening the replacement in a visible console window.
 *
 * Why this exists as a script rather than inside the plugin:
 * the process that restarts the host cannot be a child of that host. When the host is
 * killed, everything in its process tree goes with it — including the helper that was
 * supposed to bring the replacement up. So this runs detached from the host (the plugin
 * launches it through WMI, whose child has WmiPrvSE as its parent), waits for the port to
 * go quiet, and only then starts the replacement.
 *
 * Usage:
 *   node restart.js [--delay <ms>] [--port <n>] [--cwd <dir>] [--log <file>]
 *                   [--node <path>] [--bin <path>] [--hidden]
 *
 * Every path is discovered at runtime. Nothing here is specific to one machine: the Node
 * binary is process.execPath, the CLI entry is found from the running host or from PATH,
 * and the working directory defaults to the current one.
 *
 * Exit status: 0 replacement came up and stayed up; 1 it did not (reason in the log).
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    delay: Number(process.env.DSH_RESTART_DELAY_MS ?? 12000),
    port: Number(process.env.DSH_RESTART_PORT ?? 0),
    cwd: process.env.DSH_RESTART_CWD ?? '',
    log: process.env.DSH_RESTART_LOG ?? '',
    node: process.env.DSH_RESTART_NODE ?? '',
    bin: process.env.DSH_RESTART_BIN ?? '',
    hidden: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[i]
    }
    switch (arg) {
      case '--delay': out.delay = Number(next()); break
      case '--port': out.port = Number(next()); break
      case '--cwd': out.cwd = next(); break
      case '--log': out.log = next(); break
      case '--node': out.node = next(); break
      case '--bin': out.bin = next(); break
      case '--hidden': out.hidden = true; break
      case '--args': {
        // Space-separated list of arguments to pass to the replacement, e.g. --args "web"
        out.extraArgs = next().split(/\s+/).filter(Boolean)
        break
      }
      case '-h': case '--help':
        process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8')
          .split('*/')[0].replace(/^\/\*\*?/, '').replace(/^\s*\* ?/gm, '') + '\n')
        process.exit(0)
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!Number.isFinite(out.delay) || out.delay < 0) throw new Error('--delay must be a non-negative number')
  if (!Number.isInteger(out.port) || out.port < 0) throw new Error('--port must be a non-negative integer')
  return out
}

// ---------------------------------------------------------------- discovery

/**
 * Find the dsh CLI entry point.
 *
 * Preference order matters. `--bin` first: `launch.js` passes the running host's own
 * `process.argv[1]` through it, because the helper itself is started detached (by WMI) and
 * its own argv[1] is restart.js, not the host entry. Re-running exactly the entry that
 * booted the host is what makes a restart faithful, and it keeps working when dsh is not
 * on PATH at all (local installs, packaged runtimes).
 *
 * @returns {{ file: string, args: string[], viaShell: boolean, source: string }}
 */
function resolveLaunch({ bin, cwd, extraArgs = [] }) {
  // 1. Explicit override
  if (bin) {
    if (!fs.existsSync(bin)) throw new Error(`--bin does not exist: ${bin}`)
    return { file: process.execPath, args: [bin, ...extraArgs], viaShell: false, source: 'flag' }
  }

  // 2. The entry that booted this process, when this really is a DSH host
  const entry = process.argv[1]
  if (entry && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = path.resolve(entry)
    if (fs.existsSync(abs)) {
      return { file: process.execPath, args: [...process.execArgv, abs, ...extraArgs], viaShell: false, source: 'argv1' }
    }
  }

  // 3. `dsh` on PATH.
  //
  //    Only reached when there is no --bin and no host entry. Note what this must NOT do on
  //    Windows: run the `.cmd` npm shim. The shim is fine from an interactive prompt, but in
  //    a `start`-created console it exits immediately — measured: the window opened, printed
  //    nothing useful, and closed, leaving the port unserved. Resolve the shim's target
  //    (node + the package's bin.js) and run that directly instead; it needs no shell and has
  //    no quoting to get wrong.
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const probe = execFileSync(which, ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const hits = String(probe).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const shim = pickShim(hits)
    if (shim) {
      const direct = resolveShimTarget(shim, extraArgs)
      if (direct) return { ...direct, source: `path:${path.extname(shim) || 'no-ext'}->direct` }
      // No target could be derived; fall back to the shim itself.
      return { file: process.execPath, args: [], viaShell: false, source: 'path:unresolved', shim }
    }
  } catch { /* not on PATH — try the default global locations */ }

  // 4. Default global locations, so a host launched from an unconfigured shell still works
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd'),
      path.join(process.env.LOCALAPPDATA ?? '', 'npm', 'dsh.cmd'),
      path.join(path.dirname(process.execPath), 'dsh.cmd'),
    ]
    : ['/usr/local/bin/dsh', '/opt/homebrew/bin/dsh', path.join(os.homedir(), '.local', 'bin', 'dsh')]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return { file: candidate, args: [], viaShell: process.platform === 'win32', source: 'default-location' }
    }
  }

  throw new Error(
    'could not locate the dsh CLI. Pass --bin <path to lib/bin.js>, or run this from a directory where `dsh` is on PATH.',
  )
}

/** The port the host is serving on. 0 means "not given", which the caller must resolve. */
function resolvePort(port) {
  if (port > 0) return port
  const fromEnv = Number(process.env.DSH_WEB_PORT ?? 0)
  return fromEnv > 0 ? fromEnv : 3080
}

/**
 * Pick the runnable shim out of what `where dsh` returned.
 *
 * npm puts three files side by side on Windows: `dsh` (a #!/bin/sh script), `dsh.cmd` and
 * `dsh.ps1`. Only the .cmd one can be handed to cmd.exe. `where` orders the extensionless
 * POSIX script first, and choosing it produced a 124-second stall before the host answered
 * — the launch was nominally fine, it just took two minutes to start.
 */
function pickShim(hits) {
  const byExt = (ext) => hits.find((hit) => hit.toLowerCase().endsWith(ext))
  return byExt('.cmd') ?? byExt('.exe') ?? byExt('.bat') ?? hits[0]
}

/**
 * Turn a resolved `dsh` shim into a direct `node <bin.js>` invocation.
 *
 * The npm shims are thin wrappers that end up running the package's `bin.js` with a node
 * found next to them, forwarding their own arguments. Replacing the shim therefore means
 * replacing BOTH halves: the program AND the arguments it was given. Dropping the arguments
 * is what produced `error: --profile <name> is required` and a window that printed one line
 * and closed — the shim would have passed `web` along, the direct call did not.
 *
 * @param shimPath - the shim that was found on PATH
 * @param extraArgs - arguments to forward to bin.js, e.g. ['web']
 * @returns {{ file: string, args: string[], viaShell: false } | null}
 */
function resolveShimTarget(shimPath, extraArgs = []) {
  try {
    const dir = path.dirname(shimPath)
    // npm's shims reference the package entry as ...\node_modules\@scope\pkg\lib\bin.js
    const text = fs.readFileSync(shimPath, 'utf8')
    const match = text.match(/([\\/]node_modules[\\/][^\s"']*?[\\/](?:lib|dist)[\\/]bin\.(?:js|ts))/i)
    let candidate = null
    if (match) {
      candidate = path.join(dir, match[1])
    } else {
      // No parseable path (a .ps1 or an exotic shim): try the standard layout next to it.
      const guesses = [
        path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        path.join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      ]
      candidate = guesses.find((guess) => fs.existsSync(guess)) ?? null
    }
    if (!candidate || !fs.existsSync(candidate)) return null
    const node = process.execPath
    return { file: node, args: [candidate, ...extraArgs], viaShell: false }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- probing

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether something accepts a connection on `port`.
 *
 * Connect, never bind: binding to test would hold the port for the moment the replacement
 * needs it. The timer must be cleared or it keeps the event loop alive after the answer.
 */
function listening(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      probe.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 500)
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
  })
}

/** PID listening on `port`, discovered at runtime — never hardcoded. */
function portOwner(port, note) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      if (!new RegExp(`:${port}\\s`).test(line) || !/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[parts.length - 1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch (error) {
    note(`netstat failed: ${error.message}`)
  }
  return null
}

/**
 * The arguments the replacement needs, taken from the host that is running now.
 *
 * This is the piece that was missing: `dsh` on its own is not a complete command — the web
 * profile needs its `web` argument, and dropping it produces
 * `error: --profile <name> is required` in a window that closes immediately. Rather than
 * assume `web`, read the live host's command line and take everything after its entry point.
 *
 * The helper is a detached process, so it has no argv to inherit. It asks the OS instead:
 * find the PID listening on the port, read that process's command line, and split it at
 * `bin.js`.
 *
 * @returns {string[]} arguments to forward, e.g. ['web'] — empty when nothing could be read,
 *   which the caller logs so a silent drop is visible.
 */
function defaultExtraArgs(note) {
  const fromEnv = process.env.DSH_RESTART_ARGS
  if (fromEnv !== undefined) {
    const parsed = fromEnv.split(/\s+/).filter(Boolean)
    note(`args: from DSH_RESTART_ARGS = ${JSON.stringify(parsed)}`)
    return parsed
  }
  try {
    const owner = portOwner(resolvePort(Number(process.env.DSH_RESTART_PORT ?? 0)), note)
    if (owner === null) {
      note('args: no listener on the port, cannot read the host command line; assuming ["web"]')
      return ['web']
    }
    const cmdline = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${owner}").CommandLine`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()

    const marker = cmdline.toLowerCase().lastIndexOf('bin.js')
    if (marker < 0) {
      note(`args: host command line has no bin.js: ${cmdline.slice(0, 160)}; assuming ["web"]`)
      return ['web']
    }
    // Everything after bin.js, with the quotes stripped. The command line reads either
    // `"…\bin.js" web` or `"…\bin.js" "web"` depending on how the host was started, and a
    // naive whitespace split leaves quote fragments behind — measured BOTH `["\"", "web"]`
    // and `["\"web\""]`. Node would then receive an argument that is not the argument.
    //
    // So tokenize the way a shell would: a double-quoted run is one token (quotes removed),
    // and anything else is split on whitespace.
    const tail = cmdline.slice(marker + 'bin.js'.length)
    const parsed = (tail.match(/"[^"]*"|\S+/g) ?? [])
      .map((token) => token.replace(/^"+|"+$/g, '').trim())
      .filter((token) => token !== '')
    note(`args: inherited from host ${owner} = ${JSON.stringify(parsed)}`)
    return parsed
  } catch (error) {
    note(`args: could not read the host command line (${error.message}); assuming ["web"]`)
    return ['web']
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd()
  const port = resolvePort(args.port)
  const logFile = args.log || path.join(os.tmpdir(), 'dsh-restart.log')

  const note = (message) => {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`) } catch { /* logging must not break the restart */ }
  }

  const extraArgs = args.extraArgs ?? defaultExtraArgs(note)
  const launch = resolveLaunch({ bin: args.bin, cwd, extraArgs })
  note(`=== restart helper up pid=${process.pid} port=${port} ===`)
  note(`launch: ${launch.file} ${launch.args.join(' ')} (source=${launch.source}) cwd=${cwd} delay=${args.delay}ms`)

  if (!fs.existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`)

  // 1. Grace: let the current turn finish writing its reply before the host goes away.
  await sleep(args.delay)

  // 2. Find and stop the old host
  const owner = portOwner(port, note)
  note(`port ${port} owner = ${owner ?? '(none)'}`)
  if (owner === null) {
    note('no listener — nothing to stop')
  } else {
    try {
      const out = execFileSync('taskkill', ['/PID', String(owner), '/F'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      note(`taskkill /F ${owner} OK: ${out.trim()}`)
    } catch (error) {
      note(`taskkill /F ${owner} FAILED: ${`${error.stdout || ''}${error.stderr || ''}`.trim() || error.message}`)
      try {
        process.kill(owner)
        note(`process.kill(${owner}) OK`)
      } catch (inner) {
        note(`process.kill(${owner}) FAILED: ${inner.message} — aborting, will not start a second host`)
        return 1
      }
    }
  }

  // 3. Wait for the port to actually go quiet. Spawning before this is what produces
  //    EADDRINUSE and a restart that silently does nothing.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && await listening(port)) await sleep(250)
  if (await listening(port)) {
    note('ABORT: port still busy after 30s — not spawning (would EADDRINUSE)')
    return 1
  }
  await sleep(300) // a released socket can sit in TIME_WAIT for a moment on Windows
  note('port is free; starting the replacement')

  // 4. Start the replacement.
  //
  // The command goes into a .cmd file rather than a long command line. Reason, measured:
  // Node escapes embedded quotes in an argv as \" on Windows, and cmd.exe does not treat
  // backslash as an escape — the line breaks and the new window opens with nothing running
  // in it. Handing cmd a file sidesteps the quoting entirely, and spaces in paths work.
  const launcher = path.join(os.tmpdir(), `dsh-restart-launch-${process.pid}.cmd`)
  const quoted = (value) => `"${value}"`
  const command = launch.viaShell
    ? `${quoted(launch.file)}${launch.args.length ? ' ' + launch.args.map(quoted).join(' ') : ''}`
    : `${quoted(launch.file)} ${launch.args.map(quoted).join(' ')}`
  fs.writeFileSync(launcher, [
    '@echo off',
    'chcp 65001 >nul',
    `title DSH  -  ${cwd}`,
    `cd /d ${quoted(cwd)}`,
    `echo [dsh-restart] ${new Date().toISOString()}`,
    `echo [dsh-restart] command: ${command}`,
    'echo ------------------------------------------------------------',
    '',
    command,
    '',
    'echo.',
    'echo [dsh-restart] the host exited, code = %ERRORLEVEL%',
    'echo [dsh-restart] this window stays open so the output above is readable.',
    'pause',
  ].join('\r\n'), 'utf8')

  try {
    // `start` with an empty title argument: Node then emits `""` itself, and the path is
    // left unquoted here so cmd does its own quoting. Adding quotes by hand is the trap —
    // it is exactly what breaks the command line.
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/c', launcher], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: args.hidden,
      shell: false,
    })
    child.on('error', (error) => note(`spawn error: ${error.message}`))
    child.unref()
    note(`replacement window launched (pid ${child.pid ?? 'unknown'}) via ${launcher}`)
  } catch (error) {
    note(`spawn threw: ${error.message}`)
    return 1
  }

  // 5. Decide whether it worked. The port has to answer for a sustained window — a single
  //    reply counts a host that binds and then dies on startup as a success.
  const SETTLE_MS = 8000
  const HARD_LIMIT_MS = 240_000
  let steadySince = null
  const startedAt = Date.now()
  while (true) {
    if (await listening(port)) {
      if (steadySince === null) {
        steadySince = Date.now()
        note('the replacement is answering; waiting for it to stay up')
      } else if (Date.now() - steadySince >= SETTLE_MS) {
        note(`SUCCESS: port ${port} answered continuously for ${SETTLE_MS}ms — restart confirmed`)
        return 0
      }
    } else {
      if (steadySince !== null) note('the replacement stopped answering; waiting again')
      steadySince = null
      if (Date.now() - startedAt >= HARD_LIMIT_MS) {
        note(`FAIL: nothing came up on port ${port} within ${HARD_LIMIT_MS / 1000}s`)
        return 1
      }
    }
    await sleep(500)
  }
}

// Export the discovery helpers so they can be tested without running a restart, and only
// run main() when this file is executed directly rather than imported.
export { resolveLaunch, pickShim, resolveShimTarget }

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    // fileURLToPath, not URL.pathname: the pathname keeps %20 for spaces and the comparison
    // would never match in a directory whose name contains one.
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      const logFile = process.env.DSH_RESTART_LOG || path.join(os.tmpdir(), 'dsh-restart.log')
      try {
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] helper crashed: ${error?.stack ?? error}\n`)
      } catch { /* nothing left to report to */ }
      process.exit(1)
    })
}
