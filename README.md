# AstrBot ⇄ DSH 桥（打包版）

两个插件，一前一后：

```
QQ ──► AstrBot（人格 / 记忆 / 风格）── 模型决定要不要动手
                                        │
                                        ▼  HTTP（回环 + token）
                                   DSH（干活：读写文件、跑命令、查系统）
                                        │
              结果回到 AstrBot，由它用自己的语气说出来 ◄──┘
```

- **`dsh-astrbot-bridge/`** —— DSH 侧插件：提供 `/tool`、`/turn`、`/bind` 等回环接口，把任务投进会话、收回复。
- **`astrbot_dsh_bridge/`** —— AstrBot 侧插件：注册 `dsh_run` 工具，模型自己判断何时调用。

配套文档在各目录的 `README.md` 里，实现约束（挂 preset、不能借 UI 会话、UTF-8 分块）写在 DSH 那份。

## 装到干净环境

```powershell
# 两个目标路径都可以用参数覆盖；加 -DryRun 只预览不改
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -DshProfile  "$env:USERPROFILE\.dsh\profiles\desktop" `
  -AstrbotPlugins "C:\...\core\data\plugins"
```

脚本做四件事（都会先备份 profile 的 `package.json`）：

1. `dsh-astrbot-bridge/` → `<DshProfile>/node_modules/dsh-astrbot-bridge/`
2. 往 `package.json` 的 `dependencies` 加 `"dsh-astrbot-bridge": "file:<本包>/dsh-astrbot-bridge"`
3. 往 `dsh.profile.bundles` 加 `"dsh-astrbot-bridge"`
4. `astrbot_dsh_bridge/` → `<AstrbotPlugins>/astrbot_dsh_bridge/`

然后：**重启 DSH** → **重载/重启 AstrBot** → 打开插件配置页填绑定 → 聊天里发 `/dsh` 自检。

## 装完要做的三件事

1. **填绑定**：AstrBot 插件配置页 → `bindings`，一行一条
   `肥鱼:FriendMessage:2604290364 = session-…`，保存后自动推给 DSH。
   key 的第一段是 AstrBot 的平台 id（本项目里是「肥鱼」），不是适配器名。
2. **发 `/dsh`**：自检报告会告诉你 token、连通性、绑定数、当前聊天绑没绑。
3. **验一句**：QQ 里问「帮我看下 D 盘还剩多少」，应回真实数字且带人格语气。

## 已知限制

- 超时后 DSH 仍在跑，结果会被丢弃（没有 cancel）。
- 图片只传文字。
- 工作会话由插件自建，侧栏里看不到。
- 冷启动第一轮较慢（建会话 + 挂 preset），之后正常。
本内容已为旧版，部分内容与实际不符
