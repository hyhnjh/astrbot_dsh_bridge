# dsh-astrbot-bridge

让 AstrBot 用上 DSH 的「手」：**AstrBot 说话，DSH 干活。**

- AstrBot 侧保留人格、记忆、说话风格，最终回复永远由它写；
- DSH 只负责真的动手（读文件、跑命令、查系统），把结果交回去，不当对话对象。

两种用法：

| 模式 | 端点 | 谁说话 | 用途 |
|---|---|---|---|
| **工具**（推荐） | `POST /tool` | AstrBot | 模型自己判断要不要动手，DSH 输出只作为工具结果 |
| 直连（M1，兼容） | `POST /turn` | DSH | 整轮转发，DSH 直接回话——人格会丢，仅备查 |

## 接口

前缀 `/astrbot-bridge/api`，只监听回环，除 `health` 外都要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 存活探测（不需要 token） |
| POST | `/tool` | `{key, task, cwd?, images?, timeoutMs?, async?}` → `{ok, text, session, turn, partial}`；`async:true` 时立刻回 `{jobId}` |
| POST | `/turn` | `{key, text, timeoutMs?}` → 把一句聊天投进会话，返回这一轮的回复（M1，人格会丢） |
| GET | `/job?id=` | 取异步任务结果（`状态`: running / done / error） |
| GET | `/sessions` | 列活着的 DSH 会话（带标题） |
| GET | `/presets` | 列可挂的 agent presets |
| POST | `/new-session` | `{cwd?, preset?}` → 新建会话 |
| POST | `/bind` | `{key, session, label?}` → 绑定 AstrBot 会话 key |
| POST | `/unbind` | `{key}` |
| GET | `/state` | 绑定表、工作会话、限额、最近日志 |

`key` 用 AstrBot 的 `unified_msg_origin`，注意第一段是**平台 id**（你这里是「肥鱼」）：

```
肥鱼:FriendMessage:2604290364
肥鱼:GroupMessage:1125984942
```

## 配置文件

`$DSH_HOME/astrbot-bridge-config.json`（首次启动生成，token 随机）：

```json
{
  "token": "...",
  "bindings":        [{ "key": "肥鱼:FriendMessage:2604290364", "session": "session-…", "label": "" }],
  "workSessions":    { "肥鱼:FriendMessage:2604290364": "session-…" },
  "workCwd":         "C:\\Users\\<你>",
  "guestAllow":      ["bili_", "web_", "todo_", "present"],
  "denyTools":       ["bili_run"],
  "warmup":          true,
  "jobMaxWaitMs":    600000,
  "agentPreset":     "standard",
  "maxWaitMs":       60000,
  "toolTimeoutMs":   90000,
  "rateLimitPerMinute": 12,
  "splitThreshold":  800,
  "debug":           false
}
```

改完不用重启：插件每 15 秒重读；`/bind`、`/unbind` 立即写盘。
入口地址每次启动可能变，插件会写到 `$DSH_HOME/astrbot-bridge-endpoint.json`，AstrBot 侧现读。

## 三条实现约束（踩过的坑，别改回去）

1. **新会话必须挂 preset，否则没有工具。**
   `agents.create` 出来的会话只带极少工具。顺序必须是：先 create → 再 `agentPresets.recompose(agent.ctx, 'standard')`。
   把 `mount` 放进 `setup` 回调会让 agent 起不来回合（只会收到 `agent/inbox/spliced`，永远等不到 `turn/start`）。

2. **不能借用 UI 里开着的会话。**
   往侧栏里那些会话投 `followup`，同样只有 `inbox/spliced`——它们的回合由前端驱动，插件点不着。
   工作会话必须由插件自己建，这也是「聊天的归聊天，干活的归干活」。

3. **请求体要先收齐 Buffer 再按 UTF-8 解码一次。**
   逐 chunk `toString()` 会把跨包的多字节汉字切成替换字符（实测「肥鱼」被写成「鑲ラ奔」，配置文件直接坏掉）。

## 行为约定

- **禁用工具**：`denyTools` 对管理员和游客都生效（默认禁 `bili_run`——它会在后台另起一个 headless 会话把同一轮再刷一遍，双倍额度）。想恢复就把它从数组里删掉。
- **权限分档**：`/tool` 的请求体带 `admin: true/false`。管理员用 `workSessions[key]`，其他人用 `workSessions[key + "#guest"]`——两间会话、两套历史，互不污染。
- **游客白名单**：游客会话创建时用 `tools.restrict({ allow })` 把不在 `guestAllow` 前缀里的工具**从模型视野里删掉**；再补一道 `tools.guard` 硬拦作用域内注册的工具（`restrict` 对它们无效，例如 `subagent`）。resume 出来的新 agent 会被重新套一次，不会因为重启而失效。
- **权限**：只认 `127.0.0.1` / `::1`，其他来源 403；token 不对 401。
- **绑定**：没绑定的 key 一律 404，不自动建会话。
- **并发**：同一 key 同时只跑一轮（工具模式按 `tool:<key>` 单独计），第二个请求 409。
- **限流**：每 key 每分钟 12 轮，超了 429。
- **会话自动恢复**：目标会话没有活动 agent 时自动 `agents.resume`（DSH 重启后绑定不失效），resume 必须带 provider/model，否则系统提示里的 `{{model}}` 解析不出来、整轮直接 error。
- **回复归属**：只认 followup 之后第一轮 `turn/start → assistant/message → turn/end` 的文本；迟到或被打断的轮次不重复发。

## 已知限制

- 超时后 DSH 仍在跑：本轮结果丢弃，没有 cancel 接口。
- 图片只传文字。
- 没有 UI：绑定靠上面的接口或 JSON。
- 工作会话第一次由插件创建后**在侧栏里看不到**（不是 UI 注册的工作区会话）。

## 安装 / 更新

已装进 desktop profile（`package.json` 的 dependencies + `dsh.profile.bundles`）。

pnpm 的 `file:` 依赖是**拷贝**，不是软链，所以改完源码要手动同步再重载插件：

```powershell
Copy-Item 'D:\ai\dsh-astrbot-bridge\lib\host.js' `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-astrbot-bridge\lib\host.js" -Force
```

然后用 plugin_manager 把 `include:astrbot-bridge` 关一次再开一次（或重启 DSH）。

## 冒烟测试

```powershell
powershell -ExecutionPolicy Bypass -File D:\ai\dsh-astrbot-bridge\smoke.ps1
```

覆盖：健康检查、错令牌 401、未绑定 404、新建会话、绑定、跑一轮、会话在活动列表。注意它测的是 `/turn`（聊天）那条路。
