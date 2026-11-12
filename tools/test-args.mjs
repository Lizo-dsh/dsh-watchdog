/**
 * 验证 defaultExtraArgs：从运行中的宿主读取真实参数。
 * 这一步是本次修复的核心——之前漏了 `web`，导致 "error: --profile <name> is required"。
 */
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const mod = await import('./restart.js')

// defaultExtraArgs 没有导出（它是 main 的内部依赖），所以这里用等价方式复验同样的读取逻辑：
// 直接读 3080 的 host command line，看能否切出 `web`。
import { execFileSync } from 'node:child_process'
import net from 'node:net'

function portOwner(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      if (!new RegExp(`:${port}\\s`).test(line) || !/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[parts.length - 1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch { }
  return null
}

const PORT = 3080
const owner = portOwner(PORT)

if (owner === null) {
  console.log('SKIP 宿主未在监听，无法验证参数继承')
} else {
  const cmdline = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${owner}").CommandLine`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()

  console.log(`宿主 PID ${owner}`)
  console.log(`命令行: ${cmdline}`)

  const marker = cmdline.toLowerCase().lastIndexOf('bin.js')
  assert.ok(marker >= 0, '宿主命令行应含 bin.js')

  // 与 restart.js 的 tokenize 逻辑保持一致
  const tail = cmdline.slice(marker + 'bin.js'.length)
  const parsed = (tail.match(/"[^"]*"|\S+/g) ?? [])
    .map((token) => token.replace(/^"+|"+$/g, '').trim())
    .filter((token) => token !== '')
  console.log(`切出的参数: ${JSON.stringify(parsed)}`)

  assert.ok(parsed.length > 0, '必须切出至少一个参数（如 web），否则替换进程会因缺参数直接退出')
  assert.ok(!parsed.some((t) => /"/.test(t)), `不得残留引号，实际: ${JSON.stringify(parsed)}`)
  assert.ok(parsed.includes('web') || parsed.includes('--profile'), `参数应含 web 或 --profile，实际: ${JSON.stringify(parsed)}`)
  console.log('PASS 参数继承逻辑能从真实宿主取到干净的 web')
}

// ---- 静态用例：两种引号形态都必须切干净 ----
{
  // 与 restart.js 完全一致的 tokenize
  const tokenize = (tail) => (tail.match(/"[^"]*"|\S+/g) ?? [])
    .map((token) => token.replace(/^"+|"+$/g, '').trim())
    .filter((token) => token !== '')

  const cases = [
    { name: 'unquoted',  tail: ' web',        want: ['web'] },
    { name: 'quoted',    tail: ' "web"',      want: ['web'] },
    { name: 'bare-quote', tail: '" web',      want: ['web'] },
    { name: 'multi',     tail: ' web --port 3080', want: ['web', '--port', '3080'] },
    { name: 'quoted-path', tail: ' web --log "C:\\a b\\c.log"', want: ['web', '--log', 'C:\\a b\\c.log'] },
    { name: 'empty',     tail: '',            want: [] },
  ]
  for (const c of cases) {
    const got = tokenize(c.tail)
    assert.deepStrictEqual(got, c.want, `${c.name}: 期望 ${JSON.stringify(c.want)}，实际 ${JSON.stringify(got)}`)
  }
  console.log(`PASS 引号清洗 ${cases.length} 种形态全部正确`)
}

// resolveShimTarget 现在应把 extraArgs 拼进 args
{
  const fs = await import('node:fs')
  const fakeRoot = path.join(HERE, '_fake')
  const fakeBin = path.join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true })
  fs.writeFileSync(fakeBin, '// fake')
  // 假 shim 里用正斜杠引用目标，避免 Windows 反斜杠在正则里被当转义
  const shimRel = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
  const fakeShim = path.join(fakeRoot, 'dsh.cmd')
  fs.writeFileSync(fakeShim, `@"%~dp0\\${shimRel.replace(/\//g, '\\')}" %*`)
  try {
    const r = mod.resolveShimTarget(fakeShim, ['web'])
    assert.ok(r, '应解析成功')
    assert.ok(r.args.some((a) => a.endsWith('bin.js')), `args 应含 bin.js，实际: ${JSON.stringify(r.args)}`)
    assert.ok(r.args.includes('web'), `args 必须含 web，实际: ${JSON.stringify(r.args)}`)
    console.log(`PASS resolveShimTarget 拼上参数 → ${JSON.stringify(r.args)}`)
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true })
  }
}

console.log('\nALL PASS')
