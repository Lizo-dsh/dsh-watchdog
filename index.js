/**
 * dsh-watchdog — 重启后自动唤醒会话（唤醒列表版）
 *
 * 设计：
 *   模型调用 dsh_watchdog_arm 把自己的会话登记进「唤醒列表」，
 *   宿主重启后 watchdog 按列表逐个投递消息唤醒，
 *   投递成功即把该会话移出列表（唤醒即注销），不必再手动清理。
 *
 * 为什么需要落盘：宿主重启会清空内存，列表若只在内存里就和被唤醒者一起死掉。
 * 因此列表存 stateDir/registry.json，每次改动立即写盘。
 *
 * 关键实现约束（都是实测踩出来的，改代码前先读）： *  ① 必须用 ctx.inject(['sessionController'], ...) 等服务就绪，
 *     同步 ctx.get() 在挂载早期会拿到 undefined，然后每轮静默跳过。
 *  ② resolveAgent 的返回形状有两种：内层返回 { agent } 包装，外层已拆包。
 *     只认 agent 本体，两种都要兼容。
 *  ③ 投完必须 ctx.sessions.flush()，否则消息停留在内存，宿主一断就丢。
 *  ④ 投递间隔不得小于 60s（DSH 的 MIN_DELIVERY_INTERVAL_MS）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-watchdog'

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关；关闭后不读取也不投递任何登记项'),
  delaySeconds: z.number().default(30).description('宿主启动后等多久投第一条（秒）'),
  intervalSeconds: z.number().default(60).description('单条登记项失败重试间隔（秒），不小于 60'),
  maxAttempts: z.number().default(5).description('单条登记项最多尝试几次；投成功即移出列表'),
  defaultContent: z.string().default('').description('未指定内容时使用的唤醒文案；留空用内置默认'),
  stateDir: z.string().default('').description('状态目录；留空用 $DSH_HOME/dsh-watchdog'),
  sessionId: z.string().default('').description('（兼容旧配置）若列表为空则登记这个会话；留空忽略'),
})

const MIN_INTERVAL_MS = 60 * 1000

const DEFAULT_CONTENT = [
  '【watchdog 唤醒】宿主刚刚重启过，这条消息由 dsh-watchdog 自动投递。',
  '',
  '请先做三件事：',
  '1. 确认当前宿主状态（端口是否在听、新 PID 是多少）；',
  '2. 回顾上一轮做到哪一步，把未完成的部分接着做；',
  '3. 你已从唤醒列表自动移除，本次不会再被打扰；如需下次重启仍被唤醒，重新调用 dsh_watchdog_arm。',
].join('\n')

export function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    delaySeconds: Number(config.delaySeconds ?? 30),
    intervalSeconds: Number(config.intervalSeconds ?? 60),
    maxAttempts: Number(config.maxAttempts ?? 5),
    defaultContent: String(config.defaultContent ?? ''),
    stateDir: String(config.stateDir ?? ''),
    sessionId: String(config.sessionId ?? '').trim(),
  }

  const stateDir = cfg.stateDir || path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'dsh-watchdog')
  const registryPath = path.join(stateDir, 'registry.json')
  const logPath = path.join(stateDir, 'watchdog.log')

  const log = (m) => {
    const line = `[${new Date().toISOString()}] [dsh-watchdog] ${m}`
    try { ctx.logger?.info?.(`[dsh-watchdog] ${m}`) } catch { }
    // 同时落盘：ctx.logger 在挂载早期可能不存在，只靠它会把诊断全丢掉。
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.appendFileSync(logPath, line + '\n')
    } catch { /* 诊断失败不影响功能 */ }
  }

  if (!cfg.enabled) {
    log('disabled by config')
    return () => { }
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  /**
   * 本宿主生命周期的唯一标识。
   *
   * 关键作用（2026-11-12 实测出来的坑）：登记项只在「登记它的那个宿主已经死了」时才该被投递。
   * 否则会出现这个时序错误 —— 模型在 01:46:32 登记自己，30 秒后 01:47:02 投递，
   * 而重启直到 01:47:20 才发生：投递落在旧宿主里、被排进队列，等真正重启时列表已空，会话没被唤醒。
   *
   * 所以每条登记项记下登记时的 bootId，只有 bootId !== 当前 bootId 的条目才算「跨重启待唤醒」。
   */
  const bootId = `${process.pid}-${Date.now()}`
  let stopped = false
  let controller = null

  // ---------- 唤醒列表（落盘） ----------

  /** @returns {{ sessions: Record<string, {content?:string, attempts:number, addedAt:string, addedBy?:string}> }} */
  const readRegistry = () => {
    try {
      const raw = fs.readFileSync(registryPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        return parsed
      }
      log('registry file had unexpected shape; treated as empty')
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`registry read failed: ${error?.message ?? error}`)
    }
    return { sessions: {} }
  }

  const writeRegistry = (registry) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8')
      return true
    } catch (error) {
      log(`registry write failed: ${error?.message ?? error}`)
      return false
    }
  }

  /** 由 ensureScheduled 赋值；armSession 通过它触发重排（避免 TDZ） */
  let ensureScheduled = () => { }

  /** 登记一个会话；已存在则刷新内容并把 attempts 归零 */
  const armSession = (sessionId, content, addedBy) => {
    const registry = readRegistry()
    const existed = Object.prototype.hasOwnProperty.call(registry.sessions, sessionId)
    registry.sessions[sessionId] = {
      content: content ?? '',
      attempts: 0,
      addedAt: new Date().toISOString(),
      addedBy: addedBy ?? '',
      // 记下登记时的宿主生命周期。只有它变了（=宿主重启过）才会投递。
      bootId,
    }
    const ok = writeRegistry(registry)
    log(`${existed ? 're-armed' : 'armed'} ${sessionId} (total=${Object.keys(registry.sessions).length})`)
    // 运行期新登记的会话要立刻进入排程，不必等下次重启。
    // 但排程后会因为 bootId 相同而不投递 —— 见 ensureScheduled 里的判断。
    ensureScheduled()
    return ok
  }

  /** 取当前「跨重启待唤醒」的条目：bootId 与本实例不同（=上一个宿主登记的） */
  const pendingEntries = () => {
    const reg = readRegistry()
    const out = {}
    for (const [id, entry] of Object.entries(reg.sessions)) {
      if (!entry || typeof entry !== 'object') continue
      // 没有 bootId 的旧数据（升级前登记的）一律当作待唤醒，保持兼容
      if (entry.bootId === undefined || entry.bootId !== bootId) out[id] = entry
    }
    return out
  }

  const disarmSession = (sessionId, reason) => {
    const registry = readRegistry()
    if (!Object.prototype.hasOwnProperty.call(registry.sessions, sessionId)) return false
    delete registry.sessions[sessionId]
    writeRegistry(registry)
    log(`disarmed ${sessionId} reason=${reason} (total=${Object.keys(registry.sessions).length})`)
    return true
  }

  // ---------- 投递 ----------

  /**
   * 解包 resolveAgent 的返回：内层返回 { agent }，外层已拆包直接给 agent。
   * @returns {object|null} 真 agent，或 null
   */
  const unwrapAgent = (result) => {
    if (!result || typeof result !== 'object') return null
    if (typeof result.followup === 'function') return result
    if ('error' in result && result.error) {
      log(`resolveAgent returned an error result: ${JSON.stringify(result.error?.code ?? result.error)}`)
      return null
    }
    if ('agent' in result && result.agent && typeof result.agent.followup === 'function') {
      return result.agent
    }
    return null
  }

  /** 往一个会话投一条消息；返回是否成功 */
  const deliver = async (sessionId, text) => {
    const ctl = controller ?? ctx.get('sessionController') ?? ctx.sessionController
    if (!ctl || typeof ctl.resolveAgent !== 'function') {
      log(`sessionController unavailable; cannot deliver to ${sessionId}`)
      return false
    }
    let raw
    try {
      raw = await ctl.resolveAgent(sessionId)
    } catch (error) {
      log(`resolveAgent(${sessionId}) threw: ${error?.message ?? error}`)
      return false
    }
    const agent = unwrapAgent(raw)
    if (!agent) {
      log(`could not resolve a live agent for ${sessionId}`)
      return false
    }
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      try {
        const sessions = ctx.get('sessions')
        if (sessions && typeof sessions.flush === 'function') {
          const ok = await sessions.flush(agent.session)
          if (!ok) log(`flush did not acknowledge the message for ${sessionId}`)
        }
      } catch (error) {
        log(`flush failed for ${sessionId}: ${error?.message ?? error}`)
      }
      log(`delivered to ${sessionId}`)
      return true
    } catch (error) {
      log(`followup failed for ${sessionId}: ${error?.message ?? error}`)
      return false
    }
  }

  // ---------- 定时投放 ----------

  let timer = null
  let attemptRound = 0
  let started = false

  const stop = (reason) => {
    if (stopped) return false
    stopped = true
    if (timer !== null) { clearTimeout(timer); timer = null }
    log(`stopped run=${runId} reason=${reason}`)
    return true
  }

  /**
   * 确保定时器已挂上：存在「跨重启待唤醒」条目时，排一次首轮。
   *
   * 注意这里判断的是 pendingEntries() 而不是全部条目 ——
   * 本宿主刚登记的条目 bootId 相同，不算待唤醒，因此不会排出定时器。
   * 这正是修掉「登记完 30 秒就把自己唤醒、真重启时列表已空」那个时序错误的关键。
   */
  ensureScheduled = () => {
    if (stopped || timer !== null) return
    if (!started) return
    const pending = pendingEntries()
    const count = Object.keys(pending).length
    if (count === 0) return
    const first = Math.max(0, cfg.delaySeconds * 1000)
    log(`scheduling first round in ${first / 1000}s (${count} cross-boot session(s))`)
    timer = setTimeout(runRound, first)
  }

  /**
   * 跑一轮：只处理「跨重启待唤醒」的条目，逐个投递。
   * 成功的立刻移出列表；失败的累加 attempts，超上限也移出（放弃并留日志）。
   * 本宿主自己登记的条目 bootId 相同，不会被本宿主投递 —— 它们要等下一次重启。
   */
  const runRound = async () => {
    timer = null
    if (stopped) return

    const pending = pendingEntries()
    const ids = Object.keys(pending)
    if (ids.length === 0) {
      stop('no cross-boot entries left')
      return
    }

    attemptRound += 1
    log(`round ${attemptRound} starting for ${ids.length} session(s)`)

    let remaining = 0
    for (const sessionId of ids) {
      const entry = pending[sessionId]
      if (!entry) continue
      const text = (entry.content && entry.content.trim() !== '')
        ? entry.content
        : (cfg.defaultContent.trim() !== '' ? cfg.defaultContent : DEFAULT_CONTENT)

      const ok = await deliver(sessionId, text)
      if (ok) {
        disarmSession(sessionId, 'delivered')
        continue
      }

      // 失败：累加尝试次数
      const fresh = readRegistry()
      const live = fresh.sessions[sessionId]
      if (!live) continue
      live.attempts = Number(live.attempts ?? 0) + 1
      if (live.attempts >= cfg.maxAttempts) {
        delete fresh.sessions[sessionId]
        writeRegistry(fresh)
        log(`gave up on ${sessionId} after ${live.attempts} attempts; removed from list`)
      } else {
        writeRegistry(fresh)
        log(`${sessionId} attempt ${live.attempts}/${cfg.maxAttempts} failed; will retry`)
        remaining += 1
      }
    }

    if (stopped) return
    if (remaining === 0) {
      stop('all entries resolved')
      return
    }
    const gap = Math.max(MIN_INTERVAL_MS, cfg.intervalSeconds * 1000)
    log(`round ${attemptRound} done; retrying ${remaining} session(s) in ${gap / 1000}s`)
    timer = setTimeout(runRound, gap)
  }

  // ---------- 工具 ----------

  const defineTool = ({ name, description, parameters, run }) => ({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render(_args, value) { return [{ type: 'text', text: value?.text ?? '' }] },
    },
    async execute(args, execCtx) { return run(args ?? {}, execCtx) },
  })

  /** 从工具执行上下文取当前会话 id */
  const currentSessionId = (execCtx) => {
    const id = execCtx?.agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : ''
  }

  const mountTools = (inner) => {
    const registry = inner.get('tools')
    if (!registry || typeof registry.register !== 'function') {
      log('tools registry unavailable; tools not published')
      return
    }
    const publish = (definition, label) => {
      try {
        registry.register(definition)
        log(`published ${label}`)
      } catch (error) {
        log(`could not register ${label}: ${error?.message ?? error}`)
      }
    }

    publish(defineTool({
      name: 'dsh_watchdog_arm',
      description: '把「当前会话」登记进重启唤醒列表：宿主下次启动后，watchdog 会在 delaySeconds 秒后'
        + '自动向本会话投递一条消息把对话叫醒（投递成功后自动移出列表）。'
        + '适合在即将重启宿主、又不想重启后手动回来发话时调用。'
        + '不传 sessionId 默认登记当前会话；可传 content 自定义唤醒内容。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '要登记的会话 id；留空 = 当前会话' },
          content: { type: 'string', description: '唤醒时投递的内容；留空用内置默认文案' },
        },
      },
      async run(args, execCtx) {
        const target = String(args.sessionId ?? '').trim() || currentSessionId(execCtx)
        if (target === '') {
          return { text: '无法确定会话 id：既没有传 sessionId，也拿不到当前会话。' }
        }
        const ok = armSession(target, String(args.content ?? ''), 'tool')
        if (!ok) return { text: `登记失败（写盘错误），详见 ${logPath}` }
        const pending = Object.keys(pendingEntries())
        return {
          text: `已登记 ${target} 到唤醒列表。`
            + `\n该条目属于「当前这次启动」，因此现在不会投递。`
            + `\n等你下次重启宿主，新宿主启动 ${Math.max(0, cfg.delaySeconds)} 秒后才会投递唤醒消息，投递成功后自动移出列表。`
            + (pending.length > 0
              ? `\n另有 ${pending.length} 个上个宿主时代登记的条目，会在本次启动后立即唤醒：\n${pending.map((id) => '  • ' + id).join('\n')}`
              : ''),
        }
      },
    }), 'dsh_watchdog_arm')

    publish(defineTool({
      name: 'dsh_watchdog_disarm',
      description: '把会话移出重启唤醒列表。不传 sessionId 默认移出当前会话。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '要移出的会话 id；留空 = 当前会话' },
        },
      },
      async run(args, execCtx) {
        const target = String(args.sessionId ?? '').trim() || currentSessionId(execCtx)
        if (target === '') return { text: '无法确定会话 id。' }
        const removed = disarmSession(target, 'tool')
        return {
          text: removed
            ? `已把 ${target} 移出唤醒列表。`
            : `${target} 本来就不在唤醒列表里。`,
        }
      },
    }), 'dsh_watchdog_disarm')

    publish(defineTool({
      name: 'dsh_watchdog_list',
      description: '列出重启唤醒列表里的所有会话，以及本实例的运行状态（第几轮、是否已停）。',
      parameters: { type: 'object', properties: {} },
      async run() {
        const reg = readRegistry()
        const all = Object.keys(reg.sessions)
        const pendingIds = Object.keys(pendingEntries())
        const pendingSet = new Set(pendingIds)
        const lines = [
          `run=${runId}`,
          `boot=${bootId}`,
          `round=${attemptRound}`,
          `stopped=${stopped}`,
          `delay=${Math.max(0, cfg.delaySeconds)}s interval=${Math.max(60, cfg.intervalSeconds)}s maxAttempts=${cfg.maxAttempts}`,
          `registry=${registryPath}`,
          '',
          `本次启动即唤醒（${pendingIds.length}）—— 上个宿主时代登记的：`,
          ...(pendingIds.length === 0
            ? ['  (无)']
            : pendingIds.map((id) => {
              const e = reg.sessions[id]
              return `  • ${id}  attempts=${e.attempts ?? 0}  addedAt=${e.addedAt ?? '?'}`
            })),
          '',
          `等下次重启才唤醒（${all.length - pendingIds.length}）—— 本次启动登记的：`,
          ...(all.length - pendingIds.length === 0
            ? ['  (无)']
            : all.filter((id) => !pendingSet.has(id)).map((id) => {
              const e = reg.sessions[id]
              return `  • ${id}  attempts=${e.attempts ?? 0}  addedAt=${e.addedAt ?? '?'}`
            })),
        ]
        return { text: lines.join('\n') }
      },
    }), 'dsh_watchdog_list')

    publish(defineTool({
      name: 'dsh_watchdog_status',
      description: '查看 dsh-watchdog 实例状态与唤醒列表摘要。',
      parameters: { type: 'object', properties: {} },
      async run() {
        const reg = readRegistry()
        const all = Object.keys(reg.sessions)
        const pending = Object.keys(pendingEntries())
        return {
          text: [
            `run=${runId}`,
            `boot=${bootId}`,
            `round=${attemptRound}`,
            `stopped=${stopped}`,
            `wake-now=${pending.length}`,
            pending.length > 0 ? `sessions=${pending.join(', ')}` : 'sessions=(无)',
            `waiting-next-boot=${all.length - pending.length}`,
            `delay=${Math.max(0, cfg.delaySeconds)}s interval=${Math.max(60, cfg.intervalSeconds)}s maxAttempts=${cfg.maxAttempts}`,
          ].join('\n'),
        }
      },
    }), 'dsh_watchdog_status')

    publish(defineTool({
      name: 'dsh_watchdog_stop',
      description: '停止本实例的所有投递（不清空唤醒列表）。宿主下次重启仍会按列表唤醒。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '关闭原因（可选）' } },
      },
      async run(args) {
        const reason = String(args.reason ?? '').trim() || 'stopped by agent'
        const did = stop(reason)
        return {
          text: did
            ? `watchdog 已停止（run=${runId}）。唤醒列表未被清空，重启后仍会按列表唤醒。`
            : `watchdog 早已停止（run=${runId}）。`,
        }
      },
    }), 'dsh_watchdog_stop')
  }

  if (typeof ctx.inject === 'function') ctx.inject(['tools'], mountTools)
  else mountTools(ctx)

  // 兼容旧配置：列表为空且给了 sessionId，就把它种进列表（只种一次，之后由工具维护）
  if (cfg.sessionId !== '') {
    const reg = readRegistry()
    if (Object.keys(reg.sessions).length === 0) {
      armSession(cfg.sessionId, '', 'config-seed')
    }
  }

  /**
   * 等 sessionController 就绪再开始计时。
   * 依据（2026-11-11 实测）：该服务由 @deepseek-ai/dsh-api-session-controller 提供、
   * 注册在 dsh-web-app bundle，挂载早期同步 ctx.get 会拿到 undefined 并静默跳过。
   */
  const start = (inner) => {
    controller = inner.get('sessionController') ?? inner.sessionController ?? null
    log(`sessionController ready (${controller && typeof controller.resolveAgent === 'function' ? 'ok' : 'missing'})`)
    started = true

    const all = Object.keys(readRegistry().sessions)
    const pending = Object.keys(pendingEntries())
    const selfArmed = all.length - pending.length
    if (pending.length === 0) {
      log(`armed run=${runId} boot=${bootId}; no cross-boot sessions to wake (total=${all.length})`
        + (selfArmed > 0 ? `, ${selfArmed} armed in THIS boot → will wake after the next restart` : '')
        + '; idle')
      return
    }
    log(`armed run=${runId} boot=${bootId} sessions=${pending.join(',')} first=${cfg.delaySeconds}s interval=${Math.max(60, cfg.intervalSeconds)}s maxAttempts=${cfg.maxAttempts}`)
    ensureScheduled()
  }

  if (typeof ctx.inject === 'function') ctx.inject(['sessionController'], start)
  else start(ctx)

  return () => stop('unmounted')
}
