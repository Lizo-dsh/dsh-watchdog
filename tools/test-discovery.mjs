/**
 * 验证 restart.js 的探测逻辑：从 dsh shim 解析出真实的 node + bin.js。
 * import 插件时不触发 main（restart.js 已用 invokedDirectly 守卫）。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLaunch, pickShim, resolveShimTarget } from './restart.js'

// fileURLToPath, not URL.pathname: the pathname keeps %20 for spaces, and every path
// derived from it then points at a directory that does not exist.
const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---- 用例 1：pickShim 优先 .cmd ----
{
  const hits = [
    'C:\\nvm4w\\nodejs\\dsh',      // sh 脚本，where 排第一
    'C:\\nvm4w\\nodejs\\dsh.cmd',
  ]
  const picked = pickShim(hits)
  assert.ok(/\.cmd$/i.test(picked), `应优先选 .cmd，实际: ${picked}`)
  console.log(`PASS 用例1 pickShim → ${picked}`)
}

// ---- 用例 2：resolveShimTarget 从真实 shim 解析出存在的 bin.js ----
{
  const shim = 'C:\\nvm4w\\nodejs\\dsh'
  if (!fs.existsSync(shim)) {
    console.log('SKIP 用例2 本机无该 shim')
  } else {
    const r = resolveShimTarget(shim)
    assert.ok(r, '应能解析出目标')
    assert.strictEqual(r.viaShell, false, '直连模式不需要 shell')
    assert.ok(fs.existsSync(r.args[0]), `解析出的 bin.js 必须存在: ${r.args[0]}`)
    assert.ok(/[\\/]bin\.js$/.test(r.args[0]), '目标应是 bin.js')
    console.log(`PASS 用例2 解析 shim → ${r.args[0]}`)
  }
}

// ---- 用例 3：PATH 探测产出直连形态（不是 .cmd）----
{
  const r = resolveLaunch({ bin: null, cwd: HERE })
  assert.strictEqual(r.viaShell, false, '不应走 shell —— .cmd 在 start 新窗口里会立刻退出')
  assert.ok(!/\.cmd$/i.test(r.file), `file 不应是 .cmd，实际: ${r.file}`)
  assert.ok(r.args.some((a) => /[\\/]bin\.js$/.test(a)), `args 应含 bin.js，实际: ${JSON.stringify(r.args)}`)
  console.log(`PASS 用例3 直连 ${r.file} ${r.args.join(' ')}`)
  console.log(`       source=${r.source}`)
}

// ---- 用例 4：--bin 优先级最高 ----
{
  const fake = path.join(HERE, '_fake-bin.js')
  fs.writeFileSync(fake, '// fake')
  try {
    const r = resolveLaunch({ bin: fake, cwd: HERE })
    assert.strictEqual(r.source, 'flag')
    assert.ok(r.args.includes(fake))
    console.log('PASS 用例4 --bin 优先级最高')
  } finally {
    try { fs.unlinkSync(fake) } catch { }
  }
}

// ---- 用例 5：--bin 不存在必须报错 ----
{
  assert.throws(
    () => resolveLaunch({ bin: path.join(HERE, 'nope-xyz.js'), cwd: HERE }),
    /does not exist/,
    '不存在的 --bin 应明确报错',
  )
  console.log('PASS 用例5 不存在的 --bin 报错')
}

console.log('\nALL PASS')
