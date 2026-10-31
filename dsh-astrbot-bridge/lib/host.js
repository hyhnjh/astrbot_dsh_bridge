// DSH「接 AstrBot」· 宿主半边（M1）
//
// 只做一件事：AstrBot 把一条消息 POST 进来 → 投进一个已绑定的 DSH 会话 →
// 等这一轮跑完 → 把这一轮的回复原样返回给 AstrBot。
//
// 安全默认：只认回环地址 + 必须带 token；绑定表为空时一个请求都不接（不自动建会话）。
//
// 依赖的宿主服务（都由 dsh 本体提供，不自造）：
//   webServer.register({ kind:'exact', path, handler })   —— 注册 HTTP 路由
//   agents.get(sessionId) / agent.followup({...})         —— 往会话里投一句话
//   ctx.on('session/event', (session, event))             —— 收这一轮的 assistant 消息与 turn/end

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

export const name = 'astrbot-bridge'

/** 需要宿主提供：webServer（路由）+ agents（会话与 followup）+ timer（定时重读配置）+ agentLoop（新建会话）+ tools（工具白名单）+ attachments（图片）。 */
export const inject = ['agents', 'webServer', 'timer', 'agentLoop', 'tools', 'attachments']

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(HOME, 'astrbot-bridge-config.json')
const 端点文件 = join(HOME, 'astrbot-bridge-endpoint.json')
const 前缀 = '/astrbot-bridge/api'

const 默认配置 = {
  token: '',                       // 空 = 首次启动自动生成
  bindings: [],                    // [{ key, session, label }]
  maxWaitMs: 60000,                // 单轮最长等待
  rateLimitPerMinute: 12,          // 每 key 每分钟最多几轮
  splitThreshold: 800,             // 超过多少字就建议拆段（返回 segments）
  workCwd: homedir(),              // 工具模式下，工作会话默认落在哪个目录（用户主目录，换机器不用改）
  agentPreset: 'standard',         // 新会话挂哪个预设（不挂就没有工具，等于只能聊天）
  guestAllow: ['bili_', 'web_', 'todo_', 'present'], // 非管理员能用的工具（按名字前缀匹配）
  denyTools: ['bili_run'],         // 所有桥接会话一律禁用的工具（bili_run 会另起一个 headless 会话再刷一遍）
  workSessions: {},                // { AstrBot key: DSH 会话 id }，工具模式专用
  jobMaxWaitMs: 600000,            // 异步任务最多在服务端留多久结果
  warmup: true,                    // 启动时预建每间工作会话（省掉首轮 60 秒）
  toolTimeoutMs: 90000,            // 工具模式单次最长等待
  debug: false,                    // true = 把会话事件写进日志（排障用）
  logLimit: 50,
}

function 读配置() {
  let 磁盘 = {}
  try {
    if (existsSync(配置文件)) {
      // 别人用记事本/PS5.1 存过会带 BOM，JSON.parse 会直接炸掉整个配置
      磁盘 = JSON.parse(readFileSync(配置文件, 'utf8').replace(/^\uFEFF/, '') || '{}')
    }
  } catch (e) {}
  const 合并 = { ...默认配置, ...磁盘 }
  if (!Array.isArray(合并.bindings)) 合并.bindings = []
  if (!合并.token) 合并.token = randomBytes(24).toString('hex')
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(配置文件, JSON.stringify(合并, null, 2), 'utf8')
  } catch (e) {}
  return 合并
}

function 写配置(cfg) {
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(配置文件, JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch (e) {
    return false
  }
}

export function apply(ctx) {
  let 配置 = 读配置()
  const 日志 = []
  const 速率表 = new Map()   // key -> [时间戳]
  const 忙表 = new Set()     // key -> 正在跑
  const 挂起表 = new Map()   // 会话键 -> 这一轮的状态
  const 会话句柄 = new Map() // 我们自己 new 出来的会话，卸载时统一释放

  const 记账 = (说明) => {
    日志.push({ 时间: Date.now(), 说明: String(说明).slice(0, 400) })
    while (日志.length > (配置.logLimit || 50)) 日志.shift()
    try { ctx.logger?.info?.(`[astrbot-bridge] ${说明}`) } catch (e) {}
  }

  // ---------- 小工具 ----------

  const 会话键 = (id) => String(id == null ? '' : id).replace(/^session-/, '')

  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (!原) return undefined
    const 候选 = 原.startsWith('session-') ? [原, 原.slice('session-'.length)] : [原, 'session-' + 原]
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a) return a
      } catch (e) {}
    }
    return undefined
  }

  const 恢复中 = new Map() // 会话 id -> 正在跑的 resume
  const 已限制 = new Set() // 已经套过白名单的会话（进程内）
  const 任务表 = new Map() // jobId -> { id, key, 状态, 文字, partial, reason, 起, 止, 会话 }
  const 放行表 = new Map() // 会话 id -> Set<本轮临时放行的工具名>（例如说了"值班"才放 bili_run）
  const 用量表 = new Map() // 会话键 -> { 输入, 输出, 缓存读, 请求数, 更新 }
  const 总用量 = { 输入: 0, 输出: 0, 缓存读: 0, 请求数: 0 }

  /** 累计一次模型调用的用量（assistant/message 事件带的 usage）。 */
  function 记用量(键, u) {
    if (!u) return
    const 行 = 用量表.get(键) || { 输入: 0, 输出: 0, 缓存读: 0, 请求数: 0 }
    行.输入 += Number(u.inputTokens || 0)
    行.输出 += Number(u.outputTokens || 0)
    行.缓存读 += Number(u.cacheReadTokens || 0)
    行.请求数 += 1
    行.更新 = Date.now()
    用量表.set(键, 行)
    总用量.输入 += Number(u.inputTokens || 0)
    总用量.输出 += Number(u.outputTokens || 0)
    总用量.缓存读 += Number(u.cacheReadTokens || 0)
    总用量.请求数 += 1
  }

  /** 取某会话当前累计值（用于算一轮的增量）。 */
  const 用量快照 = (键) => {
    const 行 = 用量表.get(键) || { 输入: 0, 输出: 0, 缓存读: 0, 请求数: 0 }
    return { 输入: 行.输入, 输出: 行.输出, 缓存读: 行.缓存读, 请求数: 行.请求数 }
  }

  const 用量差值 = (前, 后) => ({
    输入: 后.输入 - 前.输入,
    输出: 后.输出 - 前.输出,
    缓存读: 后.缓存读 - 前.缓存读,
    请求数: 后.请求数 - 前.请求数,
  })

  /** 把工作目录登记成一个侧栏工作区（会话挂在它下面才看得见）。 */
  async function 登记工作区(目录) {
    try {
      const 登记 = ctx.get('workspaceRegistry')
      if (!登记) {
        记账('宿主没有 workspaceRegistry，会话不会出现在侧栏')
        return
      }
      const 已有 = typeof 登记.resolveByPath === 'function' ? await 登记.resolveByPath(目录) : undefined
      if (已有) {
        记账('工作目录已在侧栏工作区里：' + 目录)
        return
      }
      await 登记.create(目录, '接到 DSH')
      记账('已把工作目录登记进侧栏：' + 目录)
    } catch (错误) {
      记账('登记工作区失败（不影响干活）：' + String((错误 && 错误.message) || 错误))
    }
  }

  /** 取（必要时建）某间工作会话；管理员与游客各一间。 */
  async function 确保会话(会话档, 目录, 预设, 管理员) {
    const 已存 = String((配置.workSessions || {})[会话档] || '')
    if (已存) {
      const 活 = await 找agent按需(已存)
      if (活) {
        确保限制(活, 已存, 管理员)
        return { agent: 活, id: 已存 }
      }
    }
    const 模型 = 默认模型()
    const 柄 = await ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: 目录 },
      ...(模型 ? { agentOptions: 模型 } : {}),
    })
    // 预设要挂到「已创建的活会话」上：setup 里挂会让 agent 起不来回合（实测只有 inbox/spliced）
    try {
      const 预设服务 = ctx.get('agentPresets')
      if (预设服务 && typeof 预设服务.recompose === 'function' && 柄 && 柄.agent) {
        await 预设服务.recompose(柄.agent.ctx, 预设)
      }
    } catch (挂载错误) {
      记账('挂预设失败（会话可能没有工具）：' + String((挂载错误 && 挂载错误.message) || 挂载错误))
    }
    const id = String((柄 && 柄.agent && 柄.agent.id) || '')
    if (!id) throw new Error('create 没有返回会话 id')
    会话句柄.set(id, 柄)
    配置.workSessions = { ...(配置.workSessions || {}), [会话档]: id }
    写配置(配置)
    记账(`建了${管理员 ? '' : '游客'}工作会话 ${id}（${会话档}，cwd=${目录}）`)
    确保限制(柄.agent, id, 管理员)
    await 登记工作区(目录)
    return { agent: 柄.agent, id }
  }


  const 框住 = (任务) =>
    `（这是另一个系统的执行请求，不是聊天。请直接动手把下面这件事做完，然后只回结果本身：不要寒暄、不要自称、不要反问、不要解释你打算怎么做。\n\n任务：${任务}）`

  /** 组 followup 的 content：文字 + 可选图片（图片走 attachments 换正式引用）。 */
  async function 组内容(任务, 图们) {
    let 段 = [{ type: 'text', text: 框住(任务) }]
    const 列 = Array.isArray(图们) ? 图们.slice(0, 4) : []
    if (列.length === 0) return 段
    if (!ctx.attachments || typeof ctx.attachments.admitPromptContent !== 'function') {
      记账('宿主没有 attachments 服务，图只能丢：' + 列.length + ' 张')
      return 段
    }
    try {
      段 = 段.concat(
        列.map((图, i) => ({
          type: 'image',
          data: String(图.data || ''),
          mediaType: String(图.mediaType || 'image/png'),
          name: String(图.name || `img-${i + 1}.png`),
        })),
      )
      段 = await ctx.attachments.admitPromptContent(段)
      记账(`收了 ${列.length} 张图一并交给 DSH`)
    } catch (错误) {
      记账('图片交给 DSH 失败（这轮只转文字）：' + String((错误 && 错误.message) || 错误))
      段 = [{ type: 'text', text: 框住(任务) }]
    }
    return 段
  }

  /** 清理过期的异步任务，顺带把结果留在内存里等 AstrBot 来取。 */
  function 清理任务() {
    const 现在 = Date.now()
    const 上限 = Number(配置.jobMaxWaitMs) || 600000
    for (const [id, 任务] of 任务表) {
      if (任务.状态 !== 'running' && 现在 - (任务.止 || 任务.起) > 上限) 任务表.delete(id)
    }
  }

  /**
   * 给"非管理员"的会话套工具白名单。
   * 用引擎自己的 ctx.tools.restrict({allow: [...]})：被挡掉的工具对模型**不可见**，
   * 模型连名字都看不到，没法绕；这是工具级强制，不是提示词约束。
   */
  /**
   * 给会话套工具限制：
   *   · denyTools 对所有人生效（比如 bili_run 会另起一个 headless 会话把同一轮再刷一遍）
   *   · 非管理员再叠一层白名单（guestAllow 前缀）
   * 用引擎自己的 ctx.tools.restrict + guard：被挡掉的工具对模型**不可见**，
   * 作用域内注册的（如 subagent）挡不住，再靠 guard 按名字硬拦。
   */
  function 确保限制(agent, 会话id, 管理员) {
    if (已限制.has(会话id)) return
    try {
      const 工具作用域 = agent && agent.ctx ? agent.ctx.tools : ctx.tools
      // 用宿主的全局视图算名单（agent 作用域里的 schemas 可能已经是被限过的子集）
      const 全部 = (ctx.tools.schemas() || []).map((s) => String(s.name))
      const 禁 = Array.isArray(配置.denyTools) ? 配置.denyTools.map(String) : []
      const 前缀 = Array.isArray(配置.guestAllow) ? 配置.guestAllow.map(String) : []
      const 允许名 = (n) => !管理员 && 前缀.some((p) => p && String(n || '').startsWith(p))
      const 被禁 = (n) => 禁.some((p) => p && String(n || '') === p)

      if (!管理员) {
        const 允许 = 全部.filter((n) => 前缀.some((p) => p && n.startsWith(p)) && !被禁(n))
        if (允许.length > 0) {
          工具作用域.restrict({ allow: 允许 })
        } else {
          // allow 为空会被引擎拒绝，改用 deny 全量
          工具作用域.restrict({ deny: 全部 })
        }
      }
      // 管理员不套 restrict：denyTools 交给 guard 判，这样"本轮临时放行"才生效

      工具作用域.guard((执行) => {
        const 名 = String((执行 && 执行.name) || '')
        // ⚠ 放行表是用「去掉 session- 前缀的键」存的，这里必须同样归一化，否则永远查不到
        const 本轮 = 放行表.get(会话键(会话id))
        const 临时放行 = 本轮 && 本轮.has(名)
        if (被禁(名) && !临时放行) return `这个工具在桥接里被禁用了（${名}）；要跑值班请说「值班」或「日报」`
        if (!管理员 && !允许名(名)) return `这个操作不在可用范围内（${名}）`
        return undefined
      })

      已限制.add(会话id)
      记账(
        `${管理员 ? '管理员' : '游客'}会话 ${会话id.slice(-8)}：` +
          (管理员 ? '不限白名单' : `白名单 ${全部.filter((n) => 允许名(n) && !被禁(n)).length} 个`) +
          (禁.length ? `，禁用 ${禁.join('、')}` : ''),
      )
    } catch (错误) {
      记账('套工具限制失败（可能拿到全部工具！）：' + String((错误 && 错误.message) || 错误))
    }
  }

  const 保留数 = (全部, 禁) => 全部.filter((n) => !禁.includes(n)).length


  const 默认模型 = () => {
    try {
      const 选 = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (选 && 选.provider) return { provider: String(选.provider), model: String(选.model || '') }
    } catch (e) {}
    return undefined
  }

  /** 找不到活动 agent 时，尝试从持久化会话恢复（DSH 重启后绑定不该失效）。 */
  async function 找agent按需(id) {
    const 直接 = 找agent(id)
    if (直接) return 直接
    const 键 = String(id)
    if (恢复中.has(键)) return await 恢复中.get(键)
    const 任务 = (async () => {
      try {
        // resume 也必须带 provider/model，否则系统提示里的 {{model}} 解析不出来，整轮直接 error
        const 模型 = 默认模型()
        const 柄 = await ctx.agents.resume({
          resumeSessionId: id,
          ...(模型 ? { agentOptions: 模型 } : {}),
        })
        const 真id = String((柄 && 柄.agent && 柄.agent.id) || id)
        会话句柄.set(真id, 柄)
        记账(`恢复了会话 ${真id}`)
        return 柄 && 柄.agent
      } catch (错误) {
        记账('恢复会话失败：' + String((错误 && 错误.message) || 错误))
        return undefined
      } finally {
        恢复中.delete(键)
      }
    })()
    恢复中.set(键, 任务)
    return await 任务
  }

  const 是本地 = (req) => {
    const 地址 = String((req.socket && req.socket.remoteAddress) || '')
    return 地址 === '127.0.0.1' || 地址 === '::1' || 地址 === '::ffff:127.0.0.1'
  }

  const 取令牌 = (req) => {
    const 头 = String((req.headers && (req.headers.authorization || req.headers['x-api-key'])) || '')
    if (头.toLowerCase().startsWith('bearer ')) return 头.slice(7).trim()
    return 头.trim()
  }

  const 回 = (res, 码, 体) => {
    try {
      res.statusCode = 码
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(体))
    } catch (e) {}
  }

  const 读体 = async (req) => {
    // ⚠ 必须先把 Buffer 收齐再一次性按 UTF-8 解码：
    //   逐块 chunk.toString() 会把跨包的多字节汉字切成替换字符（实测「肥鱼」被写成「鑲ラ奔」）
    const 块们 = []
    let 总数 = 0
    try {
      for await (const 块 of req) {
        块们.push(Buffer.isBuffer(块) ? 块 : Buffer.from(块))
        总数 += 块.length
        if (总数 > 4 * 1024 * 1024) return null
      }
    } catch (e) {
      return null
    }
    try {
      return JSON.parse(Buffer.concat(块们).toString('utf8') || '{}')
    } catch (e) {
      return null
    }
  }

  const 限流通过 = (key) => {
    const 上限 = Number(配置.rateLimitPerMinute) || 0
    if (上限 <= 0) return true
    const 现在 = Date.now()
    const 历史 = (速率表.get(key) || []).filter((t) => 现在 - t < 60000)
    速率表.set(key, 历史)
    if (历史.length >= 上限) return false
    历史.push(现在)
    return true
  }

  const 拆段 = (文本) => {
    const 阈 = Number(配置.splitThreshold) || 800
    const 整 = String(文本 || '')
    if (整.length <= 阈) return 整 ? [整] : []
    // 先按空行拆；还是太长就硬切
    const 段 = 整.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
    const 结果 = []
    for (const 一 of 段) {
      if (一.length <= 阈) 结果.push(一)
      else for (let i = 0; i < 一.length; i += 阈) 结果.push(一.slice(i, i + 阈))
    }
    return 结果
  }

  // ---------- 收 DSH 的回复 ----------

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (!event) return
      const 键 = 会话键(session && session.id)
      const 挂 = 挂起表.get(键)
      if (配置.debug) {
        try {
          const 数 = event.data || {}
          记账(`[debug] ${键.slice(-6)} ${event.type} turn=${数.turn ?? '-'}${事件摘要(event)}`)
        } catch (e) {}
      }
      if (!挂) return

      // 只统计「桥接发起的那一轮」：宿主里别的会话（比如你正在聊的这个）不记，
      // 否则总用量会被别人的对话污染（实测一次就混进 118 万缓存读）
      if (event.type === 'assistant/message' && event.data && event.data.usage) {
        记用量(键, event.data.usage)
      }

      if (event.type === 'turn/start') {
        const 数 = event.data || {}
        if (挂.turn === undefined) 挂.turn = 数.turn
        return
      }

      if (event.type === 'assistant/message') {
        const 数 = event.data || {}
        if (数.interrupted) return
        const 文 = 提取正文(数.message)
        // 同一轮里可能有多条 assistant 消息（工具调用之间），取有正文的最后一条
        if (文) {
          挂.turn = 数.turn
          挂.text = 文
        }
        return
      }

      if (event.type === 'turn/end') {
        const 数 = event.data || {}
        if (挂.turn !== undefined && 数.turn !== 挂.turn) return
        挂.turn = 数.turn
        const 原因 = 数.reason || {}
        const 种类 = String(原因.kind || 'unknown')
        if (种类 !== 'completed' && 原因.error) {
          挂.错误 = String(原因.error.message || 原因.error.code || '')
        }
        挂.结束(种类 === 'completed' ? 'completed' : 种类)
      }
    }),
  )

  function 事件摘要(event) {
    try {
      if (event.type === 'turn/end') return ` reason=${event.data?.reason?.kind}`
      if (event.type === 'assistant/message') return ` blocks=${(event.data?.message?.content || []).length}`
      if (event.type === 'user/message') return ` len=${(event.data?.content || []).length}`
    } catch (e) {}
    return ''
  }

  function 提取正文(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  // ---------- 一轮 ----------

  function 跑一轮(agent, 键, 内容, 等多久) {
    return new Promise((resolve, reject) => {
      let 已结算 = false
      const 起量 = 用量快照(键)
      const 挂 = {
        turn: undefined,
        text: '',
        timer: null,
        结束: (原因) => {
          if (已结算) return
          已结算 = true
          if (挂.timer) clearTimeout(挂.timer)
          挂起表.delete(键)
          resolve({
            text: 挂.text,
            turn: 挂.turn,
            reason: 原因,
            partial: 原因 !== 'completed',
            error: 挂.错误 || '',
            用量: 用量差值(起量, 用量快照(键)),
          })
        },
      }
      挂起表.set(键, 挂)
      挂.timer = setTimeout(() => 挂.结束('timeout'), Math.max(1000, 等多久))

      Promise.resolve(
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: Array.isArray(内容) ? 内容 : [{ type: 'text', text: String(内容) }],
          source: { kind: 'astrbot' },
        }),
      ).then(
        () => {},
        (错误) => {
          if (已结算) return
          已结算 = true
          if (挂.timer) clearTimeout(挂.timer)
          挂起表.delete(键)
          reject(错误)
        },
      )
    })
  }

  // ---------- 路由 ----------

  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (错误) {
            try { 记账('路由异常：' + String((错误 && 错误.message) || 错误)) } catch (e) {}
            回(res, 500, { ok: false, code: 'internal', detail: String((错误 && 错误.message) || 错误) })
          }
        },
      }),
    )

  路线(`${前缀}/health`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    return 回(res, 200, {
      ok: true,
      version: '0.4.0',
      bindings: 配置.bindings.length,
      busy: [...忙表],
      queue: 挂起表.size,
    })
  })

  路线(`${前缀}/sessions`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    const 列 = []
    try {
      const 标题服务 = ctx.get('sessionTitle')
      for (const a of ctx.agents.list()) {
        const s = a && a.session
        if (!s || !s.id) continue
        let 标题 = ''
        try {
          const 值 = 标题服务?.get?.(s)
          标题 = typeof 值 === 'string' ? 值 : String((值 && (值.title || 值.name)) || '')
        } catch (e) {}
        列.push({ id: String(s.id), title: 标题, 已绑定: 配置.bindings.some((b) => String(b.session) === String(s.id)) })
      }
    } catch (错误) {
      return 回(res, 500, { ok: false, code: 'internal', detail: String((错误 && 错误.message) || 错误) })
    }
    return 回(res, 200, { ok: true, sessions: 列 })
  })

  路线(`${前缀}/bind`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    if (String(req.method || 'POST').toUpperCase() !== 'POST') return 回(res, 405, { ok: false, code: 'method_not_allowed' })
    const 体 = (await 读体(req)) || {}
    const 键 = String(体.key || '').trim()
    const 会话 = String(体.session || '').trim()
    if (!键 || !会话) return 回(res, 400, { ok: false, code: 'bad_request', detail: '缺 key 或 session' })
    const 新 = 读配置()
    新.bindings = 新.bindings.filter((b) => String(b.key) !== 键)
    新.bindings.push({ key: 键, session: 会话, label: String(体.label || '') })
    if (!写配置(新)) return 回(res, 500, { ok: false, code: 'internal', detail: '配置写不进去' })
    配置 = 新
    记账(`绑定 ${键} → ${会话}`)
    return 回(res, 200, { ok: true, bindings: 配置.bindings })
  })

  路线(`${前缀}/unbind`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    if (String(req.method || 'POST').toUpperCase() !== 'POST') return 回(res, 405, { ok: false, code: 'method_not_allowed' })
    const 体 = (await 读体(req)) || {}
    const 键 = String(体.key || '').trim()
    const 新 = 读配置()
    新.bindings = 新.bindings.filter((b) => String(b.key) !== 键)
    if (!写配置(新)) return 回(res, 500, { ok: false, code: 'internal' })
    配置 = 新
    记账(`解绑 ${键}`)
    return 回(res, 200, { ok: true, bindings: 配置.bindings })
  })

  路线(`${前缀}/tool`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    if (String(req.method || 'POST').toUpperCase() !== 'POST') return 回(res, 405, { ok: false, code: 'method_not_allowed' })

    const 体 = await 读体(req)
    if (体 === null) return 回(res, 400, { ok: false, code: 'bad_request', detail: 'body 不是合法 JSON' })
    const 键 = String(体.key || 'anon').trim()
    const 任务 = String(体.task || '').trim()
    if (!任务) return 回(res, 400, { ok: false, code: 'bad_request', detail: '缺 task' })

    // 管理员和普通用户各用一间工作会话，历史互不污染；普通那间套工具白名单
    const 管理员 = 体.admin === true
    const 会话档 = 管理员 ? 键 : 键 + '#guest'

    // 每个 AstrBot 聊天一个专属工作会话；第一次用时现建，之后复用（历史能接上）
    const 目录 = String(体.cwd || 配置.workCwd || homedir())
    const 预设 = String(体.preset || 配置.agentPreset || 'standard')
    let 工作会话 = ''
    let agent
    try {
      const 结果 = await 确保会话(会话档, 目录, 预设, 管理员)
      agent = 结果.agent
      工作会话 = 结果.id
    } catch (错误) {
      记账('建工作会话失败：' + String((错误 && 错误.message) || 错误))
      return 回(res, 500, { ok: false, code: 'create_failed', detail: String((错误 && 错误.message) || 错误) })
    }

    const 忙键 = 'tool:' + 会话档
    if (忙表.has(忙键)) return 回(res, 409, { ok: false, code: 'busy', detail: '这个聊天上一个任务还没跑完' })
    if (!限流通过(忙键)) return 回(res, 429, { ok: false, code: 'rate_limited' })

    // ⚠ 游客会话每轮都确认一次：resume 出来的是新 agent，限制不会自己跟过去
    确保限制(agent, 工作会话, 管理员)

    const 上限 = Math.min(Number(体.timeoutMs) || 配置.toolTimeoutMs || 90000, 180000)
    const 起 = Date.now()
    忙表.add(忙键)

    // 本轮临时放行（例如说了"值班"才允许调 bili_run）；同一 key 是串行的，不会串轮
    const 放行 = Array.isArray(体.allowTools) ? 体.allowTools.map(String) : []
    const 放行键 = 会话键(工作会话)
    if (放行.length > 0) 放行表.set(放行键, new Set(放行))
    const 任务文本 = 放行.includes('bili_run')
      ? `${任务}\n\n（注意：如果你决定调用 bili_run，就不要再自己把同一轮查一遍，二选一。）`
      : 任务

    // 异步：立刻返回 jobId，跑完把结果留在 任务表 里等 AstrBot 来取（长任务不再丢结果）
    if (体.async === true) {
      const jobId = `job-${randomUUID().slice(0, 8)}`
      任务表.set(jobId, { id: jobId, key: 会话档, 状态: 'running', 文字: '', 起, 会话: 工作会话 })
      记账(`异步任务 ${jobId}（${键}）：「${任务.slice(0, 40)}」`)
      ;(async () => {
        try {
          const 结果 = await 跑一轮(agent, 会话键(工作会话), await 组内容(任务文本, 体.images), 上限)
          const 文字 = String(结果.text || '')
          任务表.set(jobId, {
            id: jobId,
            key: 会话档,
            状态: 结果.error ? 'error' : 'done',
            文字,
            partial: Boolean(结果.partial),
            reason: 结果.reason,
            detail: 结果.error || '',
            起,
            止: Date.now(),
            会话: 工作会话,
            用量: 结果.用量 || null,
          })
          记账(`  ↳ [${jobId}] ${结果.reason}，${文字.length} 字，${Date.now() - 起}ms`)
        } catch (错误) {
          任务表.set(jobId, {
            id: jobId,
            key: 会话档,
            状态: 'error',
            文字: '',
            reason: 'exception',
            detail: String((错误 && 错误.message) || 错误),
            起,
            止: Date.now(),
            会话: 工作会话,
          })
          记账(`  ↳ [${jobId}] 失败：` + String((错误 && 错误.message) || 错误))
        } finally {
          忙表.delete(忙键)
          放行表.delete(放行键)
        }
      })()
      return 回(res, 200, { ok: true, async: true, jobId, session: 工作会话, turn: null })
    }

    try {
      记账(`任务 ${键}：「${任务.slice(0, 40)}」→ ${工作会话}`)
      const 结果 = await 跑一轮(agent, 会话键(工作会话), await 组内容(任务文本, 体.images), 上限)
      const 文字 = String(结果.text || '')
      记账(`  ↳ ${结果.reason}${结果.partial ? '（未完成）' : ''}，${文字.length} 字，${Date.now() - 起}ms`)
      return 回(res, 200, {
        ok: true,
        text: 文字,
        session: 工作会话,
        turn: 结果.turn ?? null,
        durationMs: Date.now() - 起,
        partial: Boolean(结果.partial),
        reason: 结果.reason,
        用量: 结果.用量 || null,
        ...(结果.error ? { detail: 结果.error } : {}),
      })
    } catch (错误) {
      记账('任务投递失败：' + String((错误 && 错误.message) || 错误))
      return 回(res, 503, { ok: false, code: 'agent_dead', detail: String((错误 && 错误.message) || 错误) })
    } finally {
      忙表.delete(忙键)
      放行表.delete(放行键)
    }
  })

  路线(`${前缀}/job`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    清理任务()
    const 查询 = String((req.url || '').split('?')[1] || '')
    const id = new URLSearchParams(查询).get('id') || ''
    if (!id) return 回(res, 400, { ok: false, code: 'bad_request', detail: '缺 id' })
    const 任务 = 任务表.get(id)
    if (!任务) return 回(res, 404, { ok: false, code: 'not_found', detail: `没有这个任务：${id}` })
    return 回(res, 200, { ok: true, ...任务 })
  })

  路线(`${前缀}/presets`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    try {
      const 预设服务 = ctx.get('agentPresets')
      const 列 = (await 预设服务.list()).map((p) => ({ id: p.id, name: p.name, description: p.description }))
      return 回(res, 200, { ok: true, presets: 列 })
    } catch (错误) {
      return 回(res, 500, { ok: false, code: 'internal', detail: String((错误 && 错误.message) || 错误) })
    }
  })

  路线(`${前缀}/new-session`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    if (String(req.method || 'POST').toUpperCase() !== 'POST') return 回(res, 405, { ok: false, code: 'method_not_allowed' })
    const 体 = (await 读体(req)) || {}
    const 目录 = String(体.cwd || homedir())
    const 新id = `session-${randomUUID()}`
    try {
      // 用 agents.create（会登记进 agent 注册表，get() 才找得到）；agentLoop.create 不会
      // 新会话必须带上 provider/model，否则第一轮直接 turn/end reason=error
      let agentOptions = {}
      if (体.provider) agentOptions = { provider: String(体.provider), model: String(体.model || '') }
      else {
        try {
          const 选 = ctx.get('agentDefaultModel')?.currentSelection?.()
          if (选 && 选.provider) agentOptions = { provider: 选.provider, model: 选.model }
        } catch (e) {}
      }
      const 柄 = await ctx.agents.create({
        sessionId: 新id,
        meta: { cwd: 目录, agentPreset: String(体.preset || 配置.agentPreset || 'standard') },
        ...(agentOptions.provider ? { agentOptions } : {}),
      })
      const 真id = String((柄 && 柄.agent && 柄.agent.id) || 新id)
      会话句柄.set(真id, 柄)
      记账(`新建会话 ${真id}（cwd=${目录}，模型=${agentOptions.provider || '默认'}/${agentOptions.model || '默认'}）`)
      return 回(res, 200, { ok: true, id: 真id, cwd: 目录, model: agentOptions })
    } catch (错误) {
      记账('新建会话失败：' + String((错误 && 错误.message) || 错误))
      return 回(res, 500, { ok: false, code: 'internal', detail: String((错误 && 错误.message) || 错误) })
    }
  })

  路线(`${前缀}/state`, async (req, res) => {
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })
    return 回(res, 200, {
      ok: true,
      绑定: 配置.bindings,
      工作会话: 配置.workSessions,
      白名单: 配置.guestAllow,
      用量: { 总: 总用量, 各会话: Object.fromEntries(用量表) },
      上限: { 每分: 配置.rateLimitPerMinute, 最长等待毫秒: 配置.maxWaitMs },
      忙: [...忙表],
      日志: 日志.slice(-20),
    })
  })

  路线(`${前缀}/turn`, async (req, res) => {
    if (String(req.method || 'POST').toUpperCase() !== 'POST') {
      return 回(res, 405, { ok: false, code: 'method_not_allowed' })
    }
    if (!是本地(req)) return 回(res, 403, { ok: false, code: 'forbidden_origin' })
    if (取令牌(req) !== 配置.token) return 回(res, 401, { ok: false, code: 'unauthorized' })

    const 体 = await 读体(req)
    if (体 === null) return 回(res, 400, { ok: false, code: 'bad_request', detail: 'body 不是合法 JSON' })

    const 键 = String(体.key || '').trim()
    const 文本 = String(体.text || '').trim()
    if (!键 || !文本) return 回(res, 400, { ok: false, code: 'bad_request', detail: '缺 key 或 text' })

    const 绑 = 配置.bindings.find((b) => String(b.key) === 键)
    if (!绑) return 回(res, 404, { ok: false, code: 'unknown_session', detail: `没有绑定 ${键}` })

    if (!限流通过(键)) return 回(res, 429, { ok: false, code: 'rate_limited' })
    if (忙表.has(键)) return 回(res, 409, { ok: false, code: 'busy', detail: '这个会话上一轮还没结束' })

    const agent = await 找agent按需(绑.session)
    if (!agent) return 回(res, 503, { ok: false, code: 'agent_dead', detail: `会话 ${绑.session} 现在没有活动的 agent` })

    const 会话id = (agent.session && agent.session.id) || 绑.session
    const 等多久 = Math.min(Number(体.replyTimeoutMs) || 配置.maxWaitMs, 配置.maxWaitMs)
    const 起 = Date.now()
    忙表.add(键)
    try {
      记账(`收到 ${键}：「${文本.slice(0, 40)}」→ ${绑.session}`)
      const 结果 = await 跑一轮(agent, 会话键(会话id), 文本, 等多久)
      const 文字 = 结果.text || ''
      记账(`  ↳ ${结果.reason}${结果.partial ? '（未完成）' : ''}，${文字.length} 字，${Date.now() - 起}ms`)
      return 回(res, 200, {
        ok: true,
        text: 文字,
        segments: 拆段(文字),
        turn: 结果.turn ?? null,
        durationMs: Date.now() - 起,
        partial: Boolean(结果.partial),
        reason: 结果.reason,
        用量: 结果.用量 || null,
        ...(结果.error ? { detail: 结果.error } : {}),
      })
    } catch (错误) {
      记账('投递失败：' + String((错误 && 错误.message) || 错误))
      return 回(res, 503, { ok: false, code: 'agent_dead', detail: String((错误 && 错误.message) || 错误) })
    } finally {
      忙表.delete(键)
    }
  })

  // ---------- 把入口地址写给 AstrBot（端口每次启动可能不同） ----------

  try {
    const 源 = ctx.webServer.getOrigin()
    mkdirSync(HOME, { recursive: true })
    writeFileSync(端点文件, JSON.stringify({ origin: 源, updatedAt: Date.now() }, null, 2), 'utf8')
    记账(`入口就绪：${源}${前缀}  ·  绑定 ${配置.bindings.length} 个`)
  } catch (e) {
    记账('写入口文件失败：' + String((e && e.message) || e))
  }

  // 配置被外部改了就重读（改绑定不用重启）
  ctx.effect(() =>
    ctx.timer?.interval?.(() => {
      try {
        配置 = 读配置()
      } catch (e) {}
    }, 15000),
  )

  // 预热：启动后把绑定表里每间工作会话先建好，省掉第一轮的 60 秒
  if (配置.warmup !== false) {
    ctx.effect(() =>
      ctx.timer.timeout(() => {
        void (async () => {
          const 键们 = [...new Set((配置.bindings || []).map((b) => String(b.key || '')).filter(Boolean))]
          for (const 键 of 键们) {
            for (const 管理员 of [true, false]) {
              const 档 = 管理员 ? 键 : 键 + '#guest'
              if ((配置.workSessions || {})[档]) continue
              try {
                await 确保会话(档, String(配置.workCwd || homedir()), String(配置.agentPreset || 'standard'), 管理员)
                记账(`预热完成：${档}`)
              } catch (错误) {
                记账('预热失败：' + 档 + ' ' + String((错误 && 错误.message) || 错误))
              }
            }
          }
        })()
      }, 3000),
    )
  }

  // 插件卸载时把自己建的会话交还给宿主
  ctx.effect(() => () => {
    for (const 柄 of 会话句柄.values()) {
      try { void 柄?.dispose?.() } catch (e) {}
    }
    会话句柄.clear()
    try { 记账('插件卸载，已释放自建会话') } catch (e) {}
  })
}
