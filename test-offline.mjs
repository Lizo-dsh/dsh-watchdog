/**
 * 离线桩测试（唤醒列表 + 生命周期版）。
 *
 * 最重要的一条语义（2026-11-12 实测踩出来的）：
 *   「本次启动登记的条目，不在本次启动投递」—— 它要等下一次重启。
 * 否则会出现：登记后 30 秒就把自己唤醒、投递被排进队列，
 * 等真正重启时列表已空，会话反而没被唤醒。
 *
 * 跨重启的模拟方式：直接在 registry.json 里预置一条 bootId 与本实例不同的条目。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { apply } = await import('./index.js')

// ---- 可控时钟 ----
let now = 0
const timers = []
globalThis.setTimeout = (fn, ms) => {
  const t = { fn, at: now + ms, id: timers.length }
  timers.push(t)
  return t.id
}
globalThis.clearTimeout = (id) => {
  const i = timers.findIndex(t => t.id === id)
  if (i >= 0) timers.splice(i, 1)
}

async function advance(ms) {
  const target = now + ms
  while (true) {
    timers.sort((a, b) => a.at - b.at)
    const next = timers[0]
    if (!next || next.at > target) break
    timers.shift()
    now = next.at
    await next.fn()
    await new Promise(r => setImmediate(r))
  }
  now = target
}

function freshStateDir(tag) {
  const dir = path.join(os.tmpdir(), `wd-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const regPath = (dir) => path.join(dir, 'registry.json')
const readReg = (dir) => JSON.parse(fs.readFileSync(regPath(dir), 'utf8'))

/** 预置一条「上一个宿主登记的」条目，模拟跨重启 */
function seedCrossBoot(dir, sessionId, content = '') {
  const reg = fs.existsSync(regPath(dir)) ? readReg(dir) : { sessions: {} }
  reg.sessions[sessionId] = {
    content,
    attempts: 0,
    addedAt: new Date(0).toISOString(),
    addedBy: 'seed',
    bootId: 'previous-boot-999',   // 与本实例必然不同
  }
  fs.writeFileSync(regPath(dir), JSON.stringify(reg, null, 2), 'utf8')
}

function makeCtx({ stateDir, deliverable = () => true, wrapAgent = false, hasController = true }) {
  const delivered = []
  const tools = new Map()
  const ctx = {
    logger: { info: () => { }, warn: () => { } },
    inject: (deps, fn) => {
      if (Array.isArray(deps) && deps.includes('sessionController') && !hasController) return
      fn(ctx)
    },
    get: (svc) => {
      if (svc === 'sessionController' && hasController) {
        return {
          resolveAgent: async (sessionId) => {
            if (!deliverable(sessionId)) throw new Error('session/not-found')
            const agent = {
              session: { id: sessionId },
              followup: (msg) => delivered.push({ sessionId, msg }),
            }
            return wrapAgent ? { agent } : agent
          },
        }
      }
      if (svc === 'sessions') return { flush: async () => true }
      if (svc === 'tools') return { register: (def) => { tools.set(def.name, def); return () => { } } }
      return undefined
    },
  }
  return { ctx, delivered, tools }
}

// ============================================================
// 用例 1（最关键）：本次启动登记 → 本次不投递，等下次重启
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('1')
  const { ctx, delivered, tools } = makeCtx({ stateDir })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 30, intervalSeconds: 60, maxAttempts: 5 })

  await tools.get('dsh_watchdog_arm').execute(
    { sessionId: 'session-A', content: 'wake A' },
    { agent: { session: { id: 'session-Z' } } },
  )
  assert.deepStrictEqual(Object.keys(readReg(stateDir).sessions), ['session-A'], '应落盘')

  await advance(600_000)   // 等 10 分钟
  assert.strictEqual(delivered.length, 0, '本次启动登记的条目，本次启动绝对不能投递')
  console.log('PASS 用例1 本次登记 → 本次不投（等下次重启）')
}

// ============================================================
// 用例 2：跨重启条目 → 启动后延迟投递 → 自动移出
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('2')
  seedCrossBoot(stateDir, 'session-X', 'wake X')
  const { ctx, delivered } = makeCtx({ stateDir })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 30, maxAttempts: 5 })

  assert.strictEqual(delivered.length, 0, '刚启动不该立刻投')
  await advance(29_000)
  assert.strictEqual(delivered.length, 0, '29s 还不该投')
  await advance(2_000)
  assert.strictEqual(delivered.length, 1, '30s 后应投一条')
  assert.strictEqual(delivered[0].sessionId, 'session-X')
  assert.strictEqual(delivered[0].msg.content[0].text, 'wake X')
  assert.deepStrictEqual(Object.keys(readReg(stateDir).sessions), [], '投递成功后必须移出')
  console.log('PASS 用例2 跨重启条目 → 投递 → 自动移出')
}

// ============================================================
// 用例 3：跨重启 + 本次登记混合 → 只唤醒跨重启的
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('3')
  seedCrossBoot(stateDir, 'session-OLD', 'old')
  const { ctx, delivered, tools } = makeCtx({ stateDir })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 10, maxAttempts: 5 })

  await tools.get('dsh_watchdog_arm').execute({ sessionId: 'session-NEW' }, { agent: { session: { id: 'x' } } })

  await advance(11_000)
  assert.strictEqual(delivered.length, 1, '只应唤醒跨重启的那一个')
  assert.strictEqual(delivered[0].sessionId, 'session-OLD')

  const left = Object.keys(readReg(stateDir).sessions)
  assert.deepStrictEqual(left, ['session-NEW'], '本次登记的应留在列表里等下次重启')
  console.log('PASS 用例3 混合列表只唤醒跨重启项')
}

// ============================================================
// 用例 4：多会话批量唤醒（全部跨重启）
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('4')
  seedCrossBoot(stateDir, 'session-A')
  seedCrossBoot(stateDir, 'session-B')
  seedCrossBoot(stateDir, 'session-C')
  const { ctx, delivered } = makeCtx({ stateDir })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 10, maxAttempts: 5 })

  await advance(11_000)
  assert.strictEqual(delivered.length, 3, '三个都应唤醒')
  assert.deepStrictEqual(delivered.map(d => d.sessionId).sort(), ['session-A', 'session-B', 'session-C'])
  assert.strictEqual(Object.keys(readReg(stateDir).sessions).length, 0, '全成功后清空')
  console.log('PASS 用例4 多会话批量唤醒')
}

// ============================================================
// 用例 5：失败重试到上限后放弃
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('5')
  seedCrossBoot(stateDir, 'session-BAD')
  const { ctx, delivered } = makeCtx({ stateDir, deliverable: () => false })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 5, intervalSeconds: 60, maxAttempts: 2 })

  await advance(6_000)
  assert.strictEqual(delivered.length, 0, '第一轮失败')
  assert.strictEqual(readReg(stateDir).sessions['session-BAD'].attempts, 1)

  await advance(61_000)
  assert.deepStrictEqual(Object.keys(readReg(stateDir).sessions), [], '达 maxAttempts=2 应放弃并移出')

  await advance(300_000)
  assert.strictEqual(delivered.length, 0, '放弃后不再重试')
  console.log('PASS 用例5 失败重试到上限后放弃')
}

// ============================================================
// 用例 6：{ agent } 包装形态
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('6')
  seedCrossBoot(stateDir, 'session-W')
  const { ctx, delivered } = makeCtx({ stateDir, wrapAgent: true })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 3, maxAttempts: 5 })
  await advance(4_000)
  assert.strictEqual(delivered.length, 1, '{ agent } 包装必须被解开')
  console.log('PASS 用例6 { agent } 包装解包')
}

// ============================================================
// 用例 7：disarm
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('7')
  seedCrossBoot(stateDir, 'session-D')
  const { ctx, delivered, tools } = makeCtx({ stateDir })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 10, maxAttempts: 5 })
  const dis = await tools.get('dsh_watchdog_disarm').execute({ sessionId: 'session-D' })
  assert.ok(dis.text.includes('已把'), '应报告已移出')
  await advance(20_000)
  assert.strictEqual(delivered.length, 0, 'disarm 后不应投递')
  const again = await tools.get('dsh_watchdog_disarm').execute({ sessionId: 'session-D' })
  assert.ok(again.text.includes('本来就不在'), '重复 disarm 应说明本就不在')
  console.log('PASS 用例7 disarm 生效且幂等')
}

// ============================================================
// 用例 8：空列表不挂定时器
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('8')
  const { ctx } = makeCtx({ stateDir })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 1 })
  assert.strictEqual(timers.length, 0, '空列表不应挂定时器')
  console.log('PASS 用例8 空列表静默')
}

// ============================================================
// 用例 9：无 sessionController 安全失败
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('9')
  seedCrossBoot(stateDir, 'session-N')
  const { ctx } = makeCtx({ stateDir, hasController: false })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 1 })
  await advance(10_000)
  assert.strictEqual(timers.length, 0, '无 controller 时不应进位')
  console.log('PASS 用例9 无 controller 安全失败')
}

// ============================================================
// 用例 10：总开关
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('10')
  seedCrossBoot(stateDir, 'session-X')
  const { ctx, tools } = makeCtx({ stateDir })
  apply(ctx, { enabled: false, stateDir })
  assert.strictEqual(timers.length, 0, '关闭时不应挂定时器')
  assert.strictEqual(tools.size, 0, '关闭时不应注册工具')
  console.log('PASS 用例10 总开关')
}

// ============================================================
// 用例 11：list 工具能区分两类条目
// ============================================================
{
  now = 0; timers.length = 0
  const stateDir = freshStateDir('11')
  seedCrossBoot(stateDir, 'session-PREV')
  const { ctx, tools } = makeCtx({ stateDir })
  apply(ctx, { enabled: true, stateDir, delaySeconds: 600 })
  await tools.get('dsh_watchdog_arm').execute({ sessionId: 'session-CUR' }, { agent: { session: { id: 'x' } } })
  const out = await tools.get('dsh_watchdog_list').execute({})
  assert.ok(out.text.includes('本次启动即唤醒（1）'), '应标记跨重启项数量')
  assert.ok(out.text.includes('session-PREV'), '跨重启项应出现在即时唤醒段')
  assert.ok(out.text.includes('等下次重启才唤醒（1）'), '应标记待重启项数量')
  assert.ok(out.text.includes('session-CUR'), '本次登记项应出现在待重启段')
  console.log('PASS 用例11 list 区分两类条目')
}

console.log('\nALL PASS')
