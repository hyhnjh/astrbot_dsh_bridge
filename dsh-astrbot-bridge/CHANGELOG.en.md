# Changelog

**Reach DSH** (接到 DSH) — lets AstrBot hand "work that needs hands" to a local
DeepSeek Harness instance, while the reply is still written by AstrBot itself.

Current version: **0.4.0** (2026-10-31)

---

## 0.4.0 · 2026-10-31

This release turns "it runs" into "it is safe to run": permission tiers, long
tasks that no longer lose their result, image input, cost visibility, and a
self-check that tells you what is missing.

### Added

| Feature | Notes |
|---|---|
| **Prefix mode** | Config switch. When on, `/dsh <task>` is executed directly instead of being judged by the model. Prefix is configurable (`trigger_prefix`). |
| **Images** | Images from the chat are sent as base64 (max 4, 6 MB each) and admitted through `attachments.admitPromptContent`. |
| **Long tasks survive** | Past `timeout`, the task moves to the background and the result is **pushed back to the chat** when it finishes (`job_max_wait`, default 600 s). |
| **Permission tiers** | Admins get every tool; everyone else gets the whitelist (`guestAllow` prefixes). Implemented with the engine's `tools.restrict` + `guard`, so blocked tools are invisible — not merely discouraged by a prompt. |
| **Tool denial** | `denyTools` applies to everyone; `bili_run` is denied by default. |
| **Duty keywords** | When the message contains `值班` / `日报` (configurable), `bili_run` is allowed **for that turn only**, then revoked. |
| **Warm-up** | Sessions for every binding are created 3 s after DSH starts, removing the ~60 s first-turn cost. |
| **Workspace registration** | The working directory is registered so sessions have a home in the sidebar. |
| **Token usage** | Per-turn input / output / cache-hit counters, exposed via `/state` and shown on the `/dsh` card. |
| **Config page** | A real form in AstrBot's plugin settings: mode, timeout, bindings, auto-push, admin access, prefix mode, duty keywords — each with a hint. |

### Fixed

| Issue | Impact | Cause |
|---|---|---|
| `dataclass(config=...)` from the stdlib | **Plugin never loaded**; the model improvised "I can't touch the computer" | Must use `pydantic.dataclasses.dataclass` |
| UTF-8 split across chunks | Chinese was mangled (`肥鱼` → `鑲ラ奔`), bindings broke | Per-chunk `toString()`; now buffers are concatenated before decoding |
| Duty allowance never applied | Saying "值班" still could not call `bili_run` | Allowance was keyed without the `session-` prefix, the guard looked it up with it |
| Admin dropped to 14 tools | `pwsh` and friends disappeared | An allow-list was wrongly used for admins; now only a deny list |
| Usage polluted by other sessions | Totals included ~1.18 M cached tokens from an unrelated chat | Only turns started by the bridge are counted now |
| `bili_run` ran twice | One request consumed two full rounds | It spawns its own headless session; `denyTools` closes that |

### Changed

- Configuration moved from hand-edited JSON to the plugin form; saving pushes bindings to DSH (`auto_bind`).
- `install.ps1` now adds the dependency and bundle entry to the DSH profile (with a backup).
- New chat commands: `/dsh` (self-check card), `/dsh help`, `/dsh bind <session-id>`.

---

## 0.3.0 · 2026-10-31

- Plugin config page (`_conf_schema.json`): mode, timeout, bindings, auto-push.
- `/dsh` self-check rendered as a **text-to-image card**, adding "your permission"
  and "prefix mode" rows.
- `install.ps1` takes over the profile manifest.
- Fix: single newlines were swallowed by the card template (items collapsed into
  one line); sections are now separated by blank lines.

## 0.2.0 · 2026-10-31

- Architecture moved to "route 3": AstrBot registers a `dsh_run` tool, DSH is only
  the hands, **the reply is written by AstrBot in character**.
- New `/tool` endpoint; `/turn` kept for troubleshooting.
- Fix: a newly created session only has tools after a preset is mounted, and the
  mount must happen after `create` via `recompose` (mounting inside `setup` leaves
  the agent unable to start a turn).

## 0.1.0 · 2026-10-31

- Minimum viable: `/turn` forwarding, `/bind`, loopback-only + token auth.

---

## Upgrading

1. Overwrite both plugin directories (or run `install.ps1`).
2. Restart DSH; reload or restart AstrBot.
3. Open the plugin config page and check `bindings`, `admin_full_access`, and
   `prefix_direct`.
4. Send `/dsh` — a green card means you are good.

No dependency reinstall and no data migration: the config file is backwards
compatible and missing fields fall back to defaults.

## Known limitations

- A running turn cannot be cancelled: the engine exposes no such API, so a
  timeout only moves the wait to the background.
- Tasks are delegated as a whole; you cannot pin a specific tool.
- Images are inbound only; images produced by DSH are not pushed to the chat.
- Work sessions are created by the plugin; whether the sidebar lists them depends
  on the UI's grouping.
- `bili_run` is exactly the trade-off it looks like: a full daily-report run, or
  double the spend.

## Compatibility

| Dependency | Version |
|---|---|
| AstrBot | v4.x (`FunctionTool`, `add_llm_tools`, `use_t2i`) |
| DSH | tested on 0.2.1-rc.3; needs `webServer`, `agents`, `tools`, `attachments`, `timer`, `agentLoop` |
| Node | ≥ 22 |

## License

MIT — see `LICENSE`.
