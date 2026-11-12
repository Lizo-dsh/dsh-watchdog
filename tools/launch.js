#!/usr/bin/env node
/**
 * launch.js — start restart.js OUTSIDE the DSH host's process tree.
 *
 * Why this cannot be a plain spawn:
 * the helper kills the host, and anything descended from that host dies with it (Windows
 * job objects, console groups). A helper spawned as a child would kill itself before it
 * could start the replacement.
 *
 * The way out is WMI. `Win32_Process.Create` is served by WmiPrvSE.exe, so the new process
 * becomes a child of the WMI provider — not of us. Verified: the helper's reported parent
 * is WmiPrvSE.exe, and it survives the host it is about to restart.
 *
 * Usage:
 *   node launch.js [restart.js args...]        e.g. node launch.js --delay 20000
 *   node launch.js --print                     show the WMI command line without running it
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, 'restart.js')

if (process.platform !== 'win32') {
  process.stderr.write(
    'launch.js: WMI detachment is Windows-specific.\n'
    + 'On other platforms spawn restart.js with `detached: true` yourself — it only needs to\n'
    + 'outlive the host, not the session.\n',
  )
  process.exit(1)
}

if (!fs.existsSync(HELPER)) {
  process.stderr.write(`launch.js: restart.js not found next to this script (${HELPER})\n`)
  process.exit(1)
}

const passthrough = process.argv.slice(2)

/**
 * The entry that booted THIS process, handed to the helper as --bin.
 *
 * Without it the helper has to guess: it is started detached, so its own argv[1] is
 * restart.js, and it falls back to resolving `dsh` from PATH — where `where dsh` lists the
 * extensionless POSIX shim first, which cmd.exe stalls on. Passing the real entry makes the
 * restart faithful and fast.
 *
 * Only when this process really is a DSH host entry; anything else is left to the helper's
 * own discovery.
 */
function hostEntry() {
  const entry = process.argv[1]
  if (!entry) return null
  if (!/[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) return null
  return path.resolve(entry)
}

const forwarded = [...passthrough]
const entry = hostEntry()
if (entry && !forwarded.includes('--bin') && !forwarded.some((arg) => arg.startsWith('--print'))) {
  forwarded.unshift('--bin', entry)
}

const commandLine = `"${process.execPath}" "${HELPER}"${forwarded.length
  ? ' ' + forwarded.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')
  : ''}`

if (passthrough.includes('--print')) {
  process.stdout.write(`node    : ${process.execPath}\nhelper  : ${HELPER}\nhostEntry: ${entry ?? '(none — helper will discover)'}\ncmdline : ${commandLine}\n`)
  process.exit(0)
}

// One PowerShell single-quoted string, with embedded single quotes doubled.
const psq = (value) => `'${String(value).replace(/'/g, "''")}'`

const script = [
  '$ErrorActionPreference = "Stop"',
  `$cmd = ${psq(commandLine)}`,
  `$cwd = ${psq(HERE)}`,
  // The parent of this child is WmiPrvSE.exe, which is the whole point.
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $cwd }',
  'if ($r.ReturnValue -ne 0) { Write-Output ("CREATE_FAILED return=" + $r.ReturnValue); exit 1 }',
  'Write-Output ("CREATED pid=" + $r.ProcessId)',
].join('\n')

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  process.stdout.write(out.trim() + '\n')
} catch (error) {
  process.stderr.write(`launch.js: WMI create failed\n${error.stdout || ''}${error.stderr || ''}${error.message}\n`)
  process.exit(1)
}
