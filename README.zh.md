# dsh-watchdog

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的重启唤醒插件。

重启 DSH 宿主后，你正在做事的那个对话就停住了，得自己去把它找回来、敲一句话才能继续。
`dsh-watchdog` 补上这一段：由 Agent 把自己的会话登记进唤醒列表，宿主下次启动后由插件投递
一条唤醒消息，投完即自动注销。

## 它做什么

```
Agent 调用 dsh_watchdog_arm
  → 该会话被写入持久化唤醒列表，并记下当前 boot id
    → 宿主重启（boot id 变化）
      → 新宿主向列表中每个会话投递唤醒消息
        → 投递成功即移出列表
```

消息以普通 user 角色消息投递，会话会正常跑起一轮。

## 为什么需要 boot id

唤醒条目的语义是「重启之后叫醒我」。若不做这个区分，本次启动中登记的条目会在几十秒后
**在同一次启动里**被投递掉，把它所等待的那次重启提前消耗掉。因此每条登记项都记录创建时的
`bootId`，只有来自**上一次**启动的条目才会被投递。

于是行为很好推理：

| 条目创建时机 | 何时投递 |
| --- | --- |
| 本次启动中 | 现在不投，等下次重启 |
| 上次启动中 | 本次启动后 `delaySeconds` 秒投递 |

`dsh_watchdog_list` 会把这两组分开列出。

## 工具

| 工具 | 用途 |
| --- | --- |
| `dsh_watchdog_arm` | 把当前会话（或指定会话）加入唤醒列表，可自定义文案 |
| `dsh_watchdog_disarm` | 从唤醒列表移除 |
| `dsh_watchdog_list` | 列出两组条目与实例状态 |
| `dsh_watchdog_status` | 精简状态摘要 |
| `dsh_watchdog_stop` | 停止本实例投递（**不清空**唤醒列表） |

`sessionId` 留空即当前会话。

## 安装

```bash
dsh plugin --profile <profile> add dsh-watchdog
```

从本地目录安装：

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-watchdog
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖该插件行：

```yaml
- id: dsh-watchdog
  name: dsh-watchdog
  config:
    enabled: true
    delaySeconds: 30
    intervalSeconds: 60
    maxAttempts: 5
```

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后不读取也不投递任何条目 |
| `delaySeconds` | `30` | 宿主启动后等多久开始第一轮 |
| `intervalSeconds` | `60` | 失败重试间隔，强制不低于 60 秒（宿主投递下限） |
| `maxAttempts` | `5` | 单条目最多尝试几次，超过则放弃并移除 |
| `defaultContent` | `''` | 条目未自带文案时使用的唤醒内容 |
| `stateDir` | `$DSH_HOME/dsh-watchdog` | `registry.json` 与 `watchdog.log` 所在目录 |

`intervalSeconds` **只控制重试**。投递成功即结束该条目，不会重复打扰。

## 状态与日志

```
$DSH_HOME/dsh-watchdog/registry.json   # 唤醒列表
$DSH_HOME/dsh-watchdog/watchdog.log    # 追加写入的诊断日志
```

一次正常唤起的日志形如：

```
[dsh-watchdog] sessionController ready (ok)
[dsh-watchdog] armed run=… boot=… sessions=session-… first=30s maxAttempts=5
[dsh-watchdog] scheduling first round in 30s (1 cross-boot session(s))
[dsh-watchdog] round 1 starting for 1 session(s)
[dsh-watchdog] delivered to session-…
[dsh-watchdog] disarmed session-… reason=delivered (total=0)
[dsh-watchdog] stopped run=… reason=all entries resolved
```

关键判据是 `delivered to`。只有 `round … starting` 而没有对应的 `delivered`，说明投递失败，
紧挨着的那行会给出原因。日志只增不删、不做轮转，过大时直接删除即可。

## 实现注意事项

改动本插件时有三点必须注意：

1. **用 `ctx.inject` 等 `sessionController`，不要用 `ctx.get`。**
   该服务由 `@deepseek-ai/dsh-api-session-controller` 提供（注册在 `dsh-web-app` bundle，不在
   `base`）。挂载早期同步 `ctx.get` 会拿到 `undefined`，之后每轮都静默跳过，什么都不会投递。

2. **`resolveAgent` 有两种返回形态。**
   内层控制器返回 `{ agent } | { error }`，外层直接返回 agent。认「真正带 `followup` 的那个」，
   并把 `{ error }` 当作失败处理。

3. **投递后要 flush。**
   `agent.followup()` 之后调用 `ctx.sessions.flush()`，与宿主自身调度器的做法一致；
   否则消息可能停在内存里，宿主一旦退出就丢了。

## 测试

离线桩测试，自带可控时钟，不需要宿主：

```bash
node test-offline.mjs
```

覆盖 arm/disarm、仅投递跨重启条目、多会话、失败重试到放弃、两种 `resolveAgent` 形态、
空列表待机、服务缺失时的安全失败，以及总开关。

## 已知限制

- 只投递给仍然存在的会话。已归档的会话解析会失败并在日志中说明，插件不会替你取消归档。
- 唤醒计数按启动代次计算，每次重启都会重新评估列表。
- `dsh_watchdog_stop` 只作用于当前实例。要长期关闭，请设 `enabled: false` 后重启。

## 许可

MIT
