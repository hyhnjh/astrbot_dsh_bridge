# -*- coding: utf-8 -*-
"""AstrBot → DSH 桥（路线 3：DSH 只当手）

能力：
  · tool 模式：注册 dsh_run 工具，模型自己判断要不要动手；DSH 的输出只作为工具结果
  · 前缀模式：消息以 /dsh 开头就直接转（配置页开关 prefix_direct）
  · 图片：消息里的图片转 base64 一起交给 DSH
  · 长任务：先同步等一会儿，没跑完转后台，跑完再补发一条消息到原聊天

引导：聊天里发 /dsh 看自检，/dsh help 看怎么配。
"""

import asyncio
import base64
import json
import os
import time
from pathlib import Path

import aiohttp
from pydantic import Field
from pydantic.dataclasses import dataclass

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.agent.tool import FunctionTool
from astrbot.core.astr_agent_context import AstrAgentContext

DSH_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
端点文件 = DSH_HOME / "astrbot-bridge-endpoint.json"
配置文件 = DSH_HOME / "astrbot-bridge-config.json"

默认地址 = "http://127.0.0.1:52424"
最大图字节 = 6 * 1024 * 1024


# ---------- 小工具 ----------

def dsh_入口(地址覆盖: str = "", 令牌覆盖: str = "") -> tuple[str, str]:
    """返回 (DSH 地址, token)；读不到就给空串，调用方自己退让。"""
    源 = str(地址覆盖 or "").strip()
    if not 源:
        try:
            源 = str(json.loads(端点文件.read_text("utf-8")).get("origin") or "").strip()
        except Exception:
            源 = ""
    令 = str(令牌覆盖 or "").strip()
    if not 令:
        try:
            令 = str(json.loads(配置文件.read_text("utf-8")).get("token") or "").strip()
        except Exception:
            令 = ""
    return (源 or 默认地址).rstrip("/"), 令


def 解析绑定(条目) -> list[tuple[str, str]]:
    """把 ['key = session', ...] 解析成 [(key, session), ...]。"""
    结果: list[tuple[str, str]] = []
    for 行 in (条目 or []):
        文 = str(行 or "").strip()
        if not 文 or 文.startswith("#"):
            continue
        左 = 右 = ""
        for 分隔 in ("=", "->", "→"):
            if 分隔 in 文:
                左, 右 = 文.split(分隔, 1)
                break
        else:
            块 = 文.split()
            if len(块) >= 2:
                左, 右 = 块[0], 块[1]
        if 左.strip() and 右.strip():
            结果.append((左.strip(), 右.strip()))
    return 结果


async def dsh_请求(地址: str, 令牌: str, 路径: str, 体=None, 超时: float = 15.0):
    """返回 (状态码, 解析后的 dict)。失败时状态码为 -1。"""
    url = f"{地址}/astrbot-bridge/api{路径}"
    headers = {"Authorization": f"Bearer {令牌}"} if 令牌 else {}
    try:
        timeout = aiohttp.ClientTimeout(total=超时)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            if 体 is None:
                async with session.get(url, headers=headers) as r:
                    return r.status, await r.json(content_type=None)
            async with session.post(url, json=体, headers=headers) as r:
                return r.status, await r.json(content_type=None)
    except Exception as e:
        return -1, {"error": f"{type(e).__name__}: {e}"}


def _图类型(路径: str) -> str:
    低 = str(路径 or "").lower()
    for 后缀, 类型 in ((".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"),
                       (".webp", "image/webp"), (".gif", "image/gif")):
        if 低.endswith(后缀):
            return 类型
    return "image/png"


async def 取图片块(event) -> list[dict]:
    """把消息里的图片读成 base64 交给 DSH（最多 4 张、单张 6MB）。"""
    结果: list[dict] = []
    try:
        链 = list(event.message_obj.message)
    except Exception:
        return 结果
    for 组件 in 链:
        if 组件.__class__.__name__ not in ("Image",):
            continue
        if len(结果) >= 4:
            break
        路径 = ""
        try:
            if hasattr(组件, "convert_to_file_path"):
                路径 = str(await 组件.convert_to_file_path() or "")
        except Exception as e:
            logger.warning(f"[dsh-bridge] 图片落盘失败：{e}")
        if not 路径:
            路径 = str(getattr(组件, "file", "") or getattr(组件, "url", "") or "")
        if not 路径 or not os.path.exists(路径):
            logger.info(f"[dsh-bridge] 图片拿不到本地文件，跳过：{路径[:80]}")
            continue
        try:
            if os.path.getsize(路径) > 最大图字节:
                logger.info(f"[dsh-bridge] 图片太大跳过：{路径}")
                continue
            with open(路径, "rb") as f:
                原 = f.read()
            结果.append({
                "data": base64.b64encode(原).decode("ascii"),
                "mediaType": _图类型(路径),
                "name": os.path.basename(路径) or "image.png",
            })
        except Exception as e:
            logger.warning(f"[dsh-bridge] 读图失败：{e}")
    return 结果


# ---------- LLM 工具 ----------

@dataclass(config=dict(arbitrary_types_allowed=True))
class DshRunTool(FunctionTool[AstrAgentContext]):
    """把一件"需要真的动手"的事交给 DSH，拿回结果。"""

    name: str = "dsh_run"
    description: str = (
        "让 DSH 在本机真的做一件事：查看/读写文件、跑命令、查系统状态、"
        "处理需要多步操作的任务。它只返回干完的结果，不负责跟用户说话——"
        "说完结果由你用自己的语气转述。\n"
        "不要用它聊天、寒暄、表达情绪、回答常识问题，那些你自己答。"
    )
    parameters: dict = Field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "要做的事，一条清晰的指令，例如「看一下 D 盘剩余空间」",
                },
                "cwd": {
                    "type": "string",
                    "description": "在哪个目录下做，可省略",
                },
            },
            "required": ["task"],
        }
    )

    超时: float = 90.0
    地址: str = ""
    令牌: str = ""
    管理员放行: bool = True
    插件: object = None

    async def call(self, context: ContextWrapper[AstrAgentContext], **kwargs) -> str:
        任务 = str(kwargs.get("task") or "").strip()
        目录 = str(kwargs.get("cwd") or "").strip()
        if not 任务:
            return "没有给任务内容。"

        地址, 令牌 = dsh_入口(self.地址, self.令牌)
        if not 令牌:
            return "DSH 那边还没配好（找不到 token），这次没法动手。"

        会话键 = ""
        是管理员 = False
        图块: list[dict] = []
        try:
            事件 = context.context.event
            会话键 = str(事件.unified_msg_origin)
            是管理员 = bool(事件.is_admin()) and self.管理员放行
            图块 = await 取图片块(事件)
        except Exception:
            pass

        return await 跑一次(
            地址=地址,
            令牌=令牌,
            会话键=会话键 or "anon",
            任务=任务,
            目录=目录,
            管理员=是管理员,
            图块=图块,
            最多等=self.超时,
            插件=self.插件,
        )


async def 跑一次(*, 地址, 令牌, 会话键, 任务, 目录, 管理员, 图块, 最多等, 插件) -> str:
    """起一个异步任务，轮询到完成或超时；超时则交给插件后台补发。"""
    体 = {
        "key": 会话键,
        "task": 任务,
        "admin": 管理员,
        "async": True,
        "timeoutMs": int(min(最多等, 180) * 1000),
    }
    if 目录:
        体["cwd"] = 目录
    if 图块:
        体["images"] = 图块

    # 说到"值班/日报"才临时放行 bili_run（它会在后台另起一个会话跑完整一轮）
    放行 = []
    try:
        if 插件 is not None and hasattr(插件, "值班关键词"):
            关键词 = 插件.值班关键词()
            if any(词 and 词 in 任务 for 词 in 关键词):
                放行 = ["bili_run"]
    except Exception:
        pass
    if 放行:
        体["allowTools"] = 放行

    码, 数据 = await dsh_请求(地址, 令牌, "/tool", 体, 超时=30)
    if 码 != 200 or not 数据.get("ok"):
        logger.warning(f"[dsh-bridge] 起任务失败 {码}：{数据}")
        原因 = 数据.get("code") or (f"HTTP {码}" if 码 > 0 else "连不上")
        return f"DSH 没接住这次任务（{原因}）。"

    job_id = str(数据.get("jobId") or "")
    if not job_id:
        return "DSH 没有返回任务号，这次没跑成。"

    截止 = time.time() + max(5.0, 最多等 - 5)
    while time.time() < 截止:
        await asyncio.sleep(1.5)
        码, 任务态 = await dsh_请求(地址, 令牌, f"/job?id={job_id}", 超时=12)
        if 码 != 200:
            continue
        状态 = str(任务态.get("状态") or "")
        if 状态 and 状态 != "running":
            文字 = str(任务态.get("文字") or "").strip()
            if 状态 == "error":
                return f"任务没跑成：{任务态.get('detail') or 任务态.get('reason') or '未知错误'}"
            if not 文字:
                return "任务跑完了，但没有输出。"
            if 任务态.get("partial"):
                return f"{文字}\n（还没完全跑完，上面是中间结果）"
            return 文字

    # 还没完：转到后台，跑完补发
    if 插件 is not None and hasattr(插件, "后台补发"):
        try:
            插件.后台补发(会话键, job_id, 地址, 令牌)
        except Exception as e:
            logger.warning(f"[dsh-bridge] 转后台失败：{e}")
        return "这件事还在跑，跑完我再发一条过来。"
    return "这件事还在跑（超过了我能等的时长）。"


# ---------- 插件本体 ----------

@register("astrbot_dsh_bridge", "hyhnjh", "把 @ 的消息交给 DSH 干活，结果回到原聊天", "0.4.0")
class DshBridge(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}
        模式 = self._模式()

        地址, 令牌 = dsh_入口(str(self.config.get("dsh_url") or ""), str(self.config.get("token") or ""))

        if 模式 in ("tool", "both"):
            try:
                self.context.add_llm_tools(
                    DshRunTool(
                        超时=float(self.config.get("timeout", 90)),
                        地址=str(self.config.get("dsh_url") or ""),
                        令牌=str(self.config.get("token") or ""),
                        管理员放行=bool(self.config.get("admin_full_access", True)),
                        插件=self,
                    )
                )
                logger.info("[dsh-bridge] 已注册 dsh_run 工具（工具模式）")
            except Exception as e:
                logger.error(f"[dsh-bridge] 注册 dsh_run 失败：{e}")

        logger.info(
            f"[dsh-bridge] 就绪：mode={模式} DSH={地址} token={'有' if 令牌 else '缺'} "
            f"绑定={len(解析绑定(self.config.get('bindings')))} 条 "
            f"前缀直连={'开' if self.config.get('prefix_direct') else '关'}"
        )

    # ---------- 内部 ----------

    def _模式(self) -> str:
        return str(self.config.get("mode") or "tool").strip().lower()

    def _前缀(self) -> str:
        return str(self.config.get("trigger_prefix") or "/dsh").strip()

    def 值班关键词(self) -> list[str]:
        """说到这些词，才临时放行 bili_run（另起 headless 会话跑完整一轮）。"""
        原 = self.config.get("duty_keywords")
        if 原 is None:
            return ["值班", "日报"]
        if isinstance(原, str):
            return [x.strip() for x in 原.replace("，", ",").split(",") if x.strip()]
        try:
            return [str(x).strip() for x in 原 if str(x).strip()]
        except Exception:
            return ["值班", "日报"]

    async def _推送绑定(self):
        if not bool(self.config.get("auto_bind", True)):
            return
        条目 = 解析绑定(self.config.get("bindings"))
        if not 条目:
            return
        地址, 令牌 = dsh_入口(str(self.config.get("dsh_url") or ""), str(self.config.get("token") or ""))
        if not 令牌:
            logger.warning("[dsh-bridge] 没有 token，跳过自动绑定")
            return
        for 键, 会话 in 条目:
            码, 数据 = await dsh_请求(地址, 令牌, "/bind", {"key": 键, "session": 会话, "label": "AstrBot 配置"})
            if 码 == 200:
                logger.info(f"[dsh-bridge] 已绑定 {键} → {会话}")
            else:
                logger.warning(f"[dsh-bridge] 绑定失败 {键} → {会话}（{码}）：{数据}")

    async def initialize(self):
        try:
            await self._推送绑定()
        except Exception as e:
            logger.warning(f"[dsh-bridge] 自动绑定出错：{e}")

    def 后台补发(self, 会话键: str, job_id: str, 地址: str, 令牌: str):
        """长任务的收尾：轮询到完成，把结果作为一条新消息发回原聊天。"""
        最长 = float(self.config.get("job_max_wait", 600))

        async def 跑():
            截止 = time.time() + 最长
            while time.time() < 截止:
                await asyncio.sleep(3)
                码, 任务态 = await dsh_请求(地址, 令牌, f"/job?id={job_id}", 超时=12)
                if 码 != 200:
                    continue
                状态 = str(任务态.get("状态") or "")
                if not 状态 or 状态 == "running":
                    continue
                文字 = str(任务态.get("文字") or "").strip()
                if 状态 == "error":
                    文字 = f"刚才那件事没跑成：{任务态.get('detail') or 任务态.get('reason') or '未知错误'}"
                elif not 文字:
                    文字 = "刚才那件事跑完了，但没有输出。"
                try:
                    await self.context.send_message(会话键, MessageChain().message(文字))
                    logger.info(f"[dsh-bridge] 后台结果已补发（{job_id}，{len(文字)} 字）")
                except Exception as e:
                    logger.warning(f"[dsh-bridge] 补发失败：{e}")
                return
            logger.info(f"[dsh-bridge] 后台补发超时放弃：{job_id}")

        asyncio.create_task(跑())

    # ---------- 前缀直连 ----------

    @filter.event_message_type(filter.EventMessageType.ALL, priority=1)
    async def on_prefix(self, event: AstrMessageEvent):
        """消息以 /dsh 开头 → 直接交给 DSH，不经过模型的判断。"""
        if not bool(self.config.get("prefix_direct", False)):
            return
        前缀 = self._前缀()
        if not 前缀:
            return
        原文 = str(event.message_str or "").strip()
        if not 原文.startswith(前缀):
            return

        任务 = 原文[len(前缀):].strip()
        if not 任务:
            yield event.plain_result(f"用法：{前缀} <要做的事>，例如「{前缀} 看一下 D 盘还剩多少」")
            event.stop_event()
            return

        地址, 令牌 = dsh_入口(str(self.config.get("dsh_url") or ""), str(self.config.get("token") or ""))
        if not 令牌:
            yield event.plain_result("DSH 还没配好（找不到 token），先启动一次 DSH。")
            event.stop_event()
            return

        是管理员 = False
        try:
            是管理员 = bool(event.is_admin()) and bool(self.config.get("admin_full_access", True))
        except Exception:
            pass

        结果 = await 跑一次(
            地址=地址,
            令牌=令牌,
            会话键=str(event.unified_msg_origin),
            任务=任务,
            目录="",
            管理员=是管理员,
            图块=await 取图片块(event),
            最多等=float(self.config.get("timeout", 90)),
            插件=self,
        )
        yield event.plain_result(结果)
        event.stop_event()

    # ---------- 引导命令 ----------

    @filter.command("dsh")
    async def dsh_cmd(self, event: AstrMessageEvent):
        """发 /dsh 看自检报告；/dsh help 看怎么配；/dsh bind <session> 绑定当前聊天。"""
        原文 = str(event.message_str or "").strip()
        参数 = 原文.split(maxsplit=2)
        子命令 = 参数[1].lower() if len(参数) >= 2 else ""

        # 带参数 → 当作任务直接执行（这就是 /dsh 前缀直连；命令匹配会先吃掉 /dsh，
        # 所以真正的前缀逻辑在这里，而不是单独的 on_prefix）
        if 子命令 and 子命令 not in ("help", "bind"):
            if not bool(self.config.get("prefix_direct", False)):
                yield event.plain_result(
                    "前缀直连没开。想用「/dsh <要做的事>」直接下命令，请到插件配置里打开「前缀直连」。"
                )
                return
            任务 = 原文[len(参数[0]):].strip()
            地址0, 令牌0 = dsh_入口(str(self.config.get("dsh_url") or ""), str(self.config.get("token") or ""))
            if not 令牌0:
                yield event.plain_result("DSH 还没配好（找不到 token），先启动一次 DSH。")
                return
            是管理员0 = False
            try:
                是管理员0 = bool(event.is_admin()) and bool(self.config.get("admin_full_access", True))
            except Exception:
                pass
            结果0 = await 跑一次(
                地址=地址0,
                令牌=令牌0,
                会话键=str(event.unified_msg_origin),
                任务=任务,
                目录="",
                管理员=是管理员0,
                图块=await 取图片块(event),
                最多等=float(self.config.get("timeout", 90)),
                插件=self,
            )
            yield event.plain_result(结果0)
            event.stop_event()
            return

        地址, 令牌 = dsh_入口(str(self.config.get("dsh_url") or ""), str(self.config.get("token") or ""))
        会话键 = str(event.unified_msg_origin)

        if 子命令 == "help":
            yield event.plain_result(
                "接到 DSH · 怎么配\n"
                "1) 在插件配置页填 bindings，一行一条：\n"
                "   肥鱼:FriendMessage:2604290364 = session-xxxx\n"
                "   （等号左边是 AstrBot 会话 key，右边是 DSH 会话 id）\n"
                "2) 保存后会自动推给 DSH；也可以在这里发 /dsh bind session-xxxx\n"
                "3) 发 /dsh 看自检；然后在聊天里问「帮我看下 D 盘还剩多少」验收\n"
                "想直接下命令：打开配置里的「前缀直连」，然后发 /dsh 看一下磁盘\n"
                "详见插件页 README 的「使用须知」。"
            )
            return

        if 子命令 == "bind" and len(参数) >= 3:
            会话 = 参数[2].strip()
            if not 令牌:
                yield event.plain_result("没有 token，先在插件配置里确认 DSH 已启动过。")
                return
            码, 数据 = await dsh_请求(地址, 令牌, "/bind", {"key": 会话键, "session": 会话, "label": "聊天内绑定"})
            if 码 == 200:
                yield event.plain_result(
                    f"已绑定本聊天 → {会话}。\n"
                    "注意：这是临时绑定，DSH 重启后靠它在配置里；想长期保留请把\n"
                    f"  {会话键} = {会话}\n写进插件配置的 bindings。"
                )
            else:
                yield event.plain_result(f"绑定失败（{码}）：{数据}")
            return

        # 默认：自检报告（走文转图，看着像一张卡片）
        # ⚠ 文转图模板会把单个换行当空格吃掉，所以每段之间必须留空行
        段 = ["**接到 DSH · 自检**"]
        段.append(f"模式：{self._模式()}")
        段.append(f"地址：{地址}")
        段.append(f"令牌：{'✅ 已读到' if 令牌 else '❌ 读不到'}")

        if not 令牌:
            段.append("下一步：先把 DSH 启动一次，它会生成 token。")
            yield event.plain_result("\n\n".join(段)).use_t2i(True)
            return

        码, 健康 = await dsh_请求(地址, 令牌, "/health")
        通 = 码 == 200 and bool(健康.get("ok"))
        段.append(f"连通：{'✅ 正常' if 通 else f'❌ 失败（{码}）'}")

        码2, 状态 = await dsh_请求(地址, 令牌, "/state")
        远端绑定 = 状态.get("绑定") if isinstance(状态, dict) else None
        远端数 = len(远端绑定) if isinstance(远端绑定, list) else "?"
        段.append(f"DSH 绑定：{远端数} 条")

        用量 = 状态.get("用量") if isinstance(状态, dict) else None
        if isinstance(用量, dict):
            总 = 用量.get("总") or {}
            try:
                段.append(
                    "DSH 用量（本次启动以来）：\n"
                    f"输入 {int(总.get('输入') or 0):,} · 输出 {int(总.get('输出') or 0):,} · "
                    f"缓存命中 {int(总.get('缓存读') or 0):,} · 调用 {int(总.get('请求数') or 0)} 次"
                )
            except Exception:
                pass

        本地 = 解析绑定(self.config.get("bindings"))
        命中 = [s for k, s in 本地 if k == 会话键]
        段.append(f"本聊天：{'✅ 已绑定' if 命中 else '❌ 还没绑'}")

        try:
            是管理员 = bool(event.is_admin())
        except Exception:
            是管理员 = False
        段.append(f"你的权限：{'管理员（全部工具）' if 是管理员 else '普通用户（白名单工具）'}")
        段.append(f"前缀直连：{'开（' + self._前缀() + '）' if self.config.get('prefix_direct') else '关'}")

        if 命中:
            段.append(f"→ {命中[0]}")
        else:
            段.append(f"本聊天 key：\n{会话键}")
            段.append("绑定：插件配置 bindings 加一行，或发 `/dsh bind <session-id>`")

        yield event.plain_result("\n\n".join(段)).use_t2i(True)

    # ---------- 旧行为：整轮转发（默认不启用） ----------

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        if self._模式() not in ("direct", "both"):
            return

        会话 = str(event.unified_msg_origin)
        是群 = ":GroupMessage:" in 会话
        if 是群 and not event.is_at_or_wake_command:
            return
        if (not 是群) and not bool(self.config.get("private_always", True)):
            return

        正文 = str(event.message_str or "").strip()
        前缀 = self._前缀()
        if 前缀 and 正文.startswith(前缀):
            正文 = 正文[len(前缀):].strip()
        if not 正文:
            return

        地址, 令牌 = dsh_入口(str(self.config.get("dsh_url") or ""), str(self.config.get("token") or ""))
        if not 令牌:
            return

        超时 = float(self.config.get("timeout", 55))
        体 = {"key": 会话, "text": 正文, "replyTimeoutMs": int(超时 * 1000) - 2000}

        码, 数据 = await dsh_请求(地址, 令牌, "/turn", 体, 超时=超时)
        if 码 != 200 or not 数据.get("ok"):
            logger.info(f"[dsh-bridge] DSH 没接这一轮（HTTP {码}，{数据.get('code')}），放行给 AstrBot")
            return

        文字 = str(数据.get("text") or "").strip()
        段们 = 数据.get("segments") or ([文字] if 文字 else [])
        if not 文字:
            yield event.plain_result("（DSH 这一轮没有文字回复）")
        else:
            for 段 in 段们:
                yield event.plain_result(段)
        event.stop_event()
