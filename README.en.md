# dsh-qq-onebot-bridge

Puts QQ inside DeepSeek Harness (DSH below): QQ messages drive DSH agent sessions, and the agent's replies go back to QQ automatically. For people who have a machine, a spare QQ account, and want DSH to be the bot's brain.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)
[![dsh](https://img.shields.io/badge/dsh-0.1%20%7C%200.2-6f42c1.svg)](package.json)
[![onebot](https://img.shields.io/badge/OneBot-v11-black.svg)](https://github.com/botuniverse/onebot-11)

[中文](README.md) · [Changelog](CHANGELOG.md) · [Local patches](LOCAL-PATCH.md) · current version v0.7.3

## What it solves

DSH is a local agent runtime and knows nothing about QQ; OneBot implementations such as NapCat turn QQ into JSON events on a WebSocket but do not manage sessions, context or permissions for you. This plugin fills that middle layer: **one long-lived DSH session per group / per private chat**, messages in, replies out — plus permissions, rate limits, media and group administration.

- One reverse WebSocket in, replies out the same way: no public IP, no callback URL, bound to `127.0.0.1` only; sessions group per group (`sessionMode: chat`) or per person (`user`), the host can resume the same session after a restart, with persistent memory as a fallback.
- Safe by default: with `allowUsers` / `allowGroups` empty, **everything is refused** — the allowlist is the only door. Debuggable by default: a trace id per message, a reason on every silent drop; record, replay offline and inject synthetic events. It is an independent bundle, removed with `dsh plugin --profile web remove @zfqxuz/dsh-qq-onebot-bridge`.

## Features

**Chat and look things up in QQ**
- Talk to the bot by @-mentioning it in a group or directly in private; long replies are split automatically (`maxMessageLength`, 1700 chars by default); merged-forward "chat records" are expanded into a transcript for the model (50 nodes / 4000 chars by default) instead of being dropped silently.
- Read-only queries: member roster and details, group profile, group honours/notices/essence, group files (downloadable to a private chat), group albums, image OCR, recent messages. Messages are archived per day under `qq-history/`; `/找 <keywords>` and the `qq_search_history` tool search that archive.

**Voice and images**
- Speech-to-text: quote a voice message after @-mentioning the bot in a group, or send one in private (local recognition shipped by DSH by default — audio never leaves the machine); voice replies and reading aloud need your own TTS (local GPT-SoVITS or a cloud key). Images are handed to the vision tool (`visionMode`: `tool` or native multimodal `native`); image generation is `/画 <prompt>` and needs your own OpenAI-compatible endpoint or a local SD WebUI.

**Group operations, games and automation** (grouped switches, off by default — turn on when needed)
- Moderation: `/mute` `/unmute` `/kick` (second confirmation) `/clear` `/公告` `/精华` `/名片` `/头衔` `/设管理` `/撤管理` `/邀请策略` `/加群方式` `/退群`.
- Operations: `/群打卡` (native QQ group check-in), `/全体余量`, `/禁言名单`, `/批量踢`, `/待办`, `/移动文件`, `/传图`, `/群名`, `/周报` and more. Games and automation: check-in, points, fortune/draws/tarot, dice, idiom chain, guess-the-number, votes, shared todos, activity leaderboards, reaction leaderboards, likes, pokes; scheduled reminders (daily/weekly/weekday repeats), scheduled broadcasts (RSS/weather/Minecraft), an inbound webhook, join approval, a daily report and auto-heal after disconnects.

**Controllable, debuggable, operable**
- Allowlist plus roles (`owner`/`admin` vs `guest`): guests are read-only and confined to their own directory; file writes and shell are owner-only.
- Write actions pass a global gate (20/minute, 500/day) and land in the audit log; sensitive-word filtering, anti-flood, anti-recall, reply rate limiting, message dedup and weekday quiet hours are also available. `qq-trace.jsonl` structured events with a live console event stream and per-message decision chains; record → sandboxed offline replay (never touches QQ) → event injection; one-click health check, redacted diagnostic bundle, 6-hard-constraint acceptance page.
- DSH Settings gains a「QQ助手」page: 7 groups, 59 switches, each row naming its config key; a click atomically rewrites only this plugin's block in the profile's `cordis.patch.yml` (keeping a `.bak-qqai` backup).

## Quick start

Prerequisites: Node ≥ 22.13 (the permission store uses built-in `node:sqlite`) and a spare QQ account that can be logged in by QR code. First pick how to get the code, then where to run it — **without Docker follow steps 1–5 below (recommended)**; with Docker jump to the container section at the end.

> Prefer not to do steps 1–5 by hand? The **whole stack** (DSH + plugin + console + NapCat pointers + autostart) has a one-liner:
> `curl -fsSL https://raw.githubusercontent.com/zfqxuz/qqbot-deploy/main/host/get-qqbot.sh | bash -s -- --qq <bot-QQ-number>`
> (On Windows use `install.cmd host` or the PowerShell entry in the [deploy package](https://github.com/zfqxuz/qqbot-deploy); the installer is tiered — it never reinstalls an existing Node/dsh.)

### Get the code (three ways)

- **Local directory**: you already have a source directory (you cloned it, someone gave it to you, you unpacked an archive) — just use it. **git clone**: `git clone --depth 1 https://github.com/zfqxuz/dsh-qq-onebot-bridge.git`.
- **npm package** (easiest): `dsh plugin --profile web install @zfqxuz/dsh-qq-onebot-bridge` (the newest published version on npm wins).

### 1. Install DSH

```sh
npm i -g @deepseek-ai/dsh
dsh --version            # prints a version number = success
```

### 2. Install the plugin

```sh
dsh plugin --profile web install @zfqxuz/dsh-qq-onebot-bridge   # published package, recommended

# or from a source directory (development / self-built): a local directory is linked with link:,
# so its own runtime dependency ws is not installed for you
cd <source-directory> && npm install --omit=dev && dsh plugin --profile web install <source-directory>
```

> ⚠️ Installing the dependency is not the same as mounting it: the **name you installed under** must also be listed in that profile's `package.json` under `dsh.profile.bundles` (npm installs it as `@zfqxuz/dsh-qq-onebot-bridge`; a source directory or symlink keeps the name `dsh-qq-onebot-bridge`), otherwise the loader ignores it. Two easy routes: `node control/bin/qq-seed.mjs` (fill-only, never overwrites existing config — run it with `--dry-run` first), or the DSH plugin page (Settings → Plugins → Install), where the manager does it for you.

### 3. Set the allowlist and start the host

Edit the profile's config layer — **not** the `cordis.patch.yml` in this repository root (that one only mounts the bundle):

```sh
$EDITOR ~/.dsh/profiles/web/cordis.patch.yml
```

```yaml
- id: dsh-qq-onebot-bridge
  config:
    allowUsers: [123456789]    # your own QQ id; empty = refuse every private chat
    allowGroups: [987654321]   # groups the bot serves; empty = refuse every group message
    botQq: 123456789           # the bot's own QQ id (used for @-mention detection)
```

```sh
dsh web                  # defaults to http://127.0.0.1:3080
```

Verify: the log shows `QQ bridge ready: reverse-WS ws://127.0.0.1:6700`; `ss -ltn | grep :6700` (Windows: `netstat -ano | findstr :6700`) shows a listener; a「QQ助手」page appears in DSH Settings.

### 4. Install NapCat and connect it

- Linux: `curl -fL --connect-timeout 20 --max-time 1800 -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh && bash napcat.sh --docker n --cli y --github-proxy 0`
- Windows: download [NapCat.Shell.Windows.OneKey.zip](https://github.com/NapNeko/NapCatQQ/releases/latest), run `NapCatInstaller.exe`, then double-click `napcat.bat`
- macOS: [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest)

Then, in NapCat's WebUI (`127.0.0.1:6099`) → OneBot11 network settings, add a **reverse WebSocket client** pointing at `ws://127.0.0.1:6700/`; if the plugin sets `accessToken`, use the same token here, then log in by QR code.

Verify: the console's "ports / processes" card shows ≥ 1 connection on 6700; @-mention the bot in a group with `/help` and the guide arrives. Official steps live in the [NapCat docs](https://doc.napneko.icu/guide/boot/Shell).

### 5. Start the console

```sh
npm run control                    # or node control/bin/qq-control.mjs --open
```

Defaults to `http://127.0.0.1:8799` and prints the **full URL including its token** (the token is kept in the git-ignored `qq-control.json`). Verify: the page lists the console (8799), the DSH host (port auto-detected), OneBot (6700) and NapCat (6099) with their listeners and owning processes, an "ownership" card shows who hosts the bridge (host / container / desktop), the roster and any container standby reason, and the one-click health check returns per-item pass/fail with fixes.There is also a permission/status console: `npm run acl -- init` to create the database, then `npm run acl:ui` (default `http://127.0.0.1:8798`; role/permission matrix, subject assignments, status page, `/system` and the setup wizard).

### With Docker (the other runtime)

If you would rather not install Node and NapCat on the machine, use the deployment repository **[zfqxuz/qqbot-deploy](https://github.com/zfqxuz/qqbot-deploy)**: `bash install.sh` (Windows: double-click `install.cmd`; macOS: `install.command`) runs `napcat` + `harness` (DSH with this plugin) + `console` as three containers; when it finishes, open `http://127.0.0.1:8798/setup` and follow the wizard (password → allowlist → system config → QR login). Updating and uninstalling are covered by `UPDATE-UNINSTALL.md` in that package.

## Updating and uninstalling

```sh
dsh plugin --profile web outdated                              # is there a newer version?
dsh plugin --profile web update @zfqxuz/dsh-qq-onebot-bridge   # update to the latest
dsh plugin --profile web remove @zfqxuz/dsh-qq-onebot-bridge   # uninstall
```

- The plugin is an **independent bundle**: after `remove` it is as if it was never installed. It never
  touches your session history, ACL store, message archive or workspace (those live in the data root,
  and neither updating nor uninstalling removes them).
- Installed from a source directory (`install <dir>`)? Update with
  `git -C <dir> pull && dsh plugin --profile web update`; uninstall the same way as above (then delete
  the symlink you created).
- For the whole stack (containers or bare-metal installs) see `UPDATE-UNINSTALL.md` in the deploy
  package (`update.sh` / `uninstall.sh` / `host/update-host.sh` / `host/uninstall-host.sh`).

## Configuration

Configuration lives in the **profile's `cordis.patch.yml`**, in the `config` block of `id: dsh-qq-onebot-bridge` (for example `~/.dsh/profiles/web/cordis.patch.yml`; a full example is in [examples/cordis.patch.example.yml](examples/cordis.patch.example.yml)). **Keys belong there** (outside the repo) — the file with the same name in this repository is tracked by git, so never put secrets in it. It takes effect after a host restart, or immediately when you flip a switch on the「QQ助手」page (the host hot-reloads the entry; the QQ bridge reconnects for a second or two).

Key names and defaults are taken from `Config` in `lib/index.js` (the schema is the single source of truth); the example file predates some of them, so where a value differs (for example `voiceReadingEnabled`) this table and the schema win:

| Key | Type | Default | Notes |
|---|---|---|---|
| `host` / `port` / `accessToken` | string / number / string | `127.0.0.1` / `6700` / `''` | Reverse-WS bind address and port (never change host to `0.0.0.0`); the Bearer token the OneBot side must present (empty = no check) |
| `allowUsers` / `allowGroups` | number[] / number[] | `[]` / `[]` | Private-chat / group allowlists; **empty = refuse every private chat / group message** |
| `botQq` / `replyOnlyWhenMentioned` / `mentionAliases` | number / boolean / string[] | `0` / `true` / `[]` | @-mention detection in groups: the bot's QQ id, reply only when mentioned, extra names that count when a client sends the @ as plain text |
| `acceptPrivate` / `sessionMode` | boolean / `chat`\|`user` | `true` / `chat` | Whether private chats are answered at all (still allowlisted); group session mapping: one per group / one per sender |
| `cwd` / `provider` / `model` | string / string / string | `''` / `''` / `''` | Session working directory (empty = host cwd; runtime artefacts land here); LLM provider / model overrides (empty = agent default) |
| `adminUsers` / `adminEnabled` / `identity` | number[] / boolean / object | `[]` / `true` / unset | Where admin identity and admin commands come from; master switch for admin commands; Role mapping: `enabled` / `map` / `defaultRole` / `groupRole` / `groupRoles` / `perSubjectDirs` |
| `aclEnabled` / `aclDbFile` / `permissionPreset` | boolean / string / string | `true` / `''` / `''` | Use `acl.db` as the role/permission source (empty path = `config/acl.db` under the data root); falls back to config translation when the database is absent; DSH permission preset used by QQ sessions (empty = host default) |
| `maxMessageLength` / `botName` | number / string | `1700` / `小鲸鱼` | Max chars per outbound message (longer is chunked); bot display name (merged-forward card signature) |
| `actionRatePerMinute` / `actionRatePerDay` / `actionAuditEnabled` | number / number / boolean | `20` / `500` / `true` | Global gate for write actions across all chats (over-limit calls are refused with a reason); write actions and denials go to `qq-actions.log` |
| `rateLimitEnabled` / `dedupEnabled` / `quietHoursEnabled` / `quietHours` | boolean / boolean / boolean / string[] | `false` / `true` / `false` / `['9:00-12:00','14:00-18:00']` | Outbound reply rate limiting (`rateLimitMaxReplies` / `rateLimitWindowSeconds`); ignore duplicate message ids within `dedupWindowSeconds`; Weekday quiet windows in which nothing is answered (reminders and vote results still fire); local time `H:MM-H:MM`, midnight crossing allowed |
| `memoryEnabled` / `memoryMaxEntries` / `sessionResumeEnabled` | boolean / number / boolean | `true` / `30` / `true` | Per-chat persistent memory (`qq-memory/`) and its size; resume the same session after a host restart |
| `sessionConflictPolicy` / `sessionConflictWaitSeconds` / `sessionConflictNoticeSeconds` / `sessionConflictMaxQueued` / `sessionConflictBackoffSeconds` / `harnessHeartbeatEnabled` / `harnessHeartbeatSeconds` | enum / number / number / number / number[] / boolean / number | `wait` / `180` / `8` / `5` / `[5,15,60,300,900]` / `true` / `5` | **When another client holds the session's write lock**: take the message, queue it, and replay it in order in the original session once the lock frees (`fork` = new session after the deadline, `fail` = old behaviour); timeouts and drops are always reported. **Ownership heartbeat**: every N seconds write this instance's heartbeat under `<data root>/state/harness/` and elect an owner - when host and container share the data root this is what decides whether this instance should run a harness; `/health` and the console show who owns it |
| `reminderEnabled` / `reminderMaxPerChat` | boolean / number | `true` / `10` | Scheduled reminders (groups require an @-mention; stored in `qq-reminders.json`) and the per-chat cap |
| `traceEnabled` / `traceLevel` / `traceMemorySize` / `recordInbound` / `inboxRedact` | boolean / enum / number / boolean / boolean | `true` / `debug` / `500` / `true` / `false` | Full-pipeline events (`warn` keeps problems only and saves disk); recent events kept in memory; Record every inbound frame into `qq-inbox.jsonl` (offline replay depends on it); mask QQ ids while recording |
| `injectEnabled` / `injectDryRun` / `sttEnabled` / `sttProvider` | boolean / boolean / boolean / enum | `false` / `true` / `false` / `dsh` | Event injection channel and its dry-run; **leave dry-run on**; Speech-to-text; `dsh` = host-local recognition (audio stays on the machine), `cloud` = `sttBaseUrl` + `sttApiKey` |
| `ttsEnabled` / `ttsProvider` / `imageGenEnabled` / `imageGenProvider` | boolean / enum / boolean / enum | `false` / `azure` / `false` / `openai` | Voice replies (**bring your own TTS**); `local` = local GPT-SoVITS; Image generation (**bring your own backend**); the command is `imageGenCommand` (default `/画`) |
| `privateImageView` / `groupImageView` / `visionMode` / `memberQueryEnabled` / `groupFileEnabled` / `groupFileDownloadEnabled` | boolean / boolean / enum / boolean / boolean / boolean | `true` / `true` / `tool` / `true` / `true` / `true` | Download images the other side sends for the vision tool (stored in `qq-images/`); `native` = multimodal attachments; `/成员` and `qq_member_info`; `/文件` listing; `/取` downloads (private chat only). Same family: `albumEnabled`, `ocrEnabled` |
| `historyArchiveEnabled` / `historyArchiveKeepDays` / `historySearchEnabled` / `historySearchDays` / `forwardExpandEnabled` | boolean / number / boolean / number / boolean | `true` / `90` / `true` / `7` / `true` | Archive messages per day into `qq-history/`; expired files are moved to the trash, never deleted outright; `/找` and the `qq_search_history` tool (default number of days scanned); Expand merged-forward cards (`forwardMaxNodes` 50 / `forwardMaxChars` 4000) |
| `imageRetentionDays` / `imageTrashEnabled` | number / boolean | `14` / `true` | Media retention in days; expired files are **recycled, not destroyed** (moved to `qq-trash/<date>/`) |
| `ffmpegPath` | string | `ffmpeg` | Used for voice → WAV, GIF first frame, image compression and local TTS → mp3 |

The remaining 150+ keys fall into two families. **Feature switch groups** (off by default, turn on when needed): `keywordEnabled`, `pointsEnabled`, `gameEnabled`, `antiRecallEnabled`, `filterEnabled`/`filterWordsFile`/`filterAction`, `floodEnabled`, `verifyEnabled`, `statsEnabled`, `checkinEnabled`, `welcomeEnabled`, `dailyReportEnabled`, `broadcastEnabled`/`broadcastJobs`, `webhookEnabled`/`webhookPort`/`webhookSources`, `engageEnabled` and its sub-switches, `groupOpsEnabled` and its sub-switches, `autoHealEnabled`, `notifyEnabled`. **Layout keys**: `dataRoot` (the data root, see `lib/paths.js`) and `persona` (persona injection, see [LOCAL-PATCH.md](LOCAL-PATCH.md)) — both are read by the code although they are not in the schema.

## Commands and tools

Group usage requires an @-mention (private-only commands are noted), and everything is subject to the allowlist and roles. The list mirrors the actual `/help` output.

| Command | What it does | Requirements |
|---|---|---|
| `/help` (`帮助`/`菜单`), `/new`, `/status`, `/health`, `/summary`, `/reminders`, `/撤回`, `/export` | Usage guide, new session, session status, runtime diagnosis, summarise this session, list reminders, recall the last message, export the transcript | Allowlisted; everything except guide/new/status/health has its own switch (on by default) |
| `/找 <keywords>` | Search this chat's archive of the last N days (space-separated = all terms) | `historySearchEnabled` |
| `/荣誉` `/公告` `/群精华` `/群信息`, `/成员 [@someone]` | Read-only group info, member roster and details | `groupReadEnabled`, `memberQueryEnabled` |
| `/文件 [folder]`, `/取 <name>`, `/相册`, `/ocr`, `/mc <host[:port]>` | Group file browsing and download (private chat only), group albums, text out of a quoted image, Minecraft server status | The first four need NapCat-specific APIs |
| `签到` / `签到榜`, `今日人品`/`运势`/`抽签`/`塔罗`, `.r 3d6`, `/抽一个 A B C` | Local check-in, fortune, dice (pure local, no model call) | `checkinEnabled`; fortune and dice are on by default |
| `/积分` `/排行榜` `/转账 @someone N`, `接龙`/`猜数字`/`不玩了` | Points economy, in-group mini-games | `pointsEnabled`, `gameEnabled` (off by default) |
| `投票：question? A xx B xx`, `/vote`, `/vote-end`, `/todo add\|list\|done\|clear`, `记一下：xxx` | Votes and shared todos (stored in `qq-todos/`) | `voteEnabled`, `todoEnabled` (on by default) |
| `/统计` `/活跃榜` `/周榜`, `/赞榜`, `/谁赞了 <message id>`, `/点赞 [@someone]`, `/戳 @someone` | Activity stats, reaction stats, profile likes, pokes | Individual switches (off by default); `/戳` also needs an admin |
| `/日报 [on\|off]`, `/kw add\|del\|list`, `/播报 [测试 <id>]` | Daily report, keyword wordbook, scheduled-job and webhook status | Their switch + admin |
| `/待审`, `/同意 <index>`, `/拒绝 <index>`, `/同意 all` | Join / friend-request approval queue | `verifyEnabled` + admin |
| `/mute` `/unmute` `/kick` `/clear` `/公告` `/精华` `/名片` `/头衔` `/全员禁言` `/解除全员禁言` | Group moderation (`/kick` needs a second confirmation in chat) | Admin |
| `/设管理` `/撤管理` `/邀请策略` `/加群方式 1–5` `/退群 确认`, `/ws`, `/handoff` `/交接` | Group admin policy, workspace switching, session handoff | Admin; `/ws` and `/handoff` are superuser-only |

Group operations toolbox (after `groupOpsEnabled`; write sub-commands require the bot to be a group admin): `/群打卡`, `/全体余量`, `/禁言名单`, `/群详细`, `/入群通知`, `/打卡名册`, `/管理员名单`, `/批量踢` (second confirmation), `/待办` `/完成待办` `/取消待办`, `/移动文件` `/重命名文件` `/删文件` `/新建文件夹`, `/传图`, `/群名` `/群备注`, `/群权限`, `/历史可见`, `/申请`, `/周报` — each with its own sub-switch (`opsReadEnabled`, `opsKickEnabled`, `opsFileEnabled`, …).

Agent tools (inside QQ sessions; registered or not according to role permissions): `qq_send_image` / `qq_send_file` / `qq_send_voice` (send local media, bounded by `agentMediaToolsEnabled`, `fileSendDirs`, `fileSendMaxBytes`), `qq_recall` (recall the bot's own recent message), `qq_member_info`, `qq_recent_history`, `qq_search_history`, `qq_react` (emoji reaction instead of a message; a write action through the gate), `qq_face_list` / `qq_face_send` (`faceEnabled`).

## Permissions and security

**Two doors, in order: allowlist → role.**

- Allowlist: `allowUsers` / `allowGroups` empty means everything is refused; anyone outside it never even reaches the agent. Role: `identity` (`map` / `groupRoles` / `defaultRole`) plus `adminUsers` decide who a person or group is; the default is `guest` and it fails closed (an unrecognised role name is treated as guest, so a typo cannot escalate), and `owner` and `admin` are historical aliases of the same superuser identity.
- Permission store: `aclEnabled` is on by default and roles, grants, denies and limits all live in `acl.db` (`npm run acl -- init` creates it, `import-config` imports assignments from config, `aclBootstrap: true` seeds it on first start). Without the database it falls back to translating the config, exactly as before. The GUI is the permission console (`npm run acl:ui`), the CLI is `npm run acl`.

**What a guest can touch (the real boundary)**

- One directory per subject: `<data root>/subjects/u<QQ>` or `g<group id>` — it is the session cwd, the root of the restricted read tools and the root of sendable files. Groups are isolated from groups and people from people; **members of the same group are not isolated from each other** (`identity.perSubjectDirs: false` disables this, not recommended).
- Read tools (`read` / `glob` / `grep`) are confined to the subject directory plus `<data root>/subjects/shared`; host-level tools (`session_read`, `ecs_*`, `n8n_*`, `gh_*`, `bash`, …) are trimmed by the permission allowlist and simply not registered without a grant. A guest cannot write files, cannot run a shell and cannot send files from outside its own directory (`fileSendDirs` does not apply to guests).
- Superusers use the full preset from the profile; `permissionPreset` can override it per role, but `identity.roles.*.preset` defaults to `qq-coding` / `qq-readonly`, which must exist in the profile — if they do not, the session logs one warning and degrades to host-level tools only; it never silently grants more.

**Outbound actions, audit and sensitive data**

- Write actions (messages, recalls, group moderation, uploads, forwards) share the `actionRatePerMinute` and `actionRatePerDay` budget; over-limit calls are refused and recorded. `actionAuditEnabled` is on by default and both actions and denials land in `qq-actions.log`; `/kick`, `/批量踢` and `/退群` require a second confirmation in chat.
- `accessToken`, `sttApiKey`, `ttsApiKey`, `imageGenApiKey` and webhook `token`/`secret` are schema secrets: the runtime snapshot and diagnostic bundle never contain the plaintext. The console's "export diagnostic bundle" is redacted by default (QQ ids masked, message bodies replaced with "[已脱敏 N 字]", with a `REDACTED.json` describing the policy).
- Recorded artefacts (`qq-inbox.jsonl` with message bodies, `qq-trace.jsonl` with chat keys and text snippets, `qq-actions.log`) are written to the local machine only and are covered by the `.gitignore` `qq-*` rules, so a cwd inside the repository still cannot commit them. Both consoles bind `127.0.0.1` only, every endpoint needs its token, and cross-site requests carrying an `Origin` are refused.

## Compatibility

| Item | Range |
|---|---|
| DSH | Peer ranges cover `^0.1.x` and `^0.2.0-rc.2`; the CLI/web host and the official desktop client run the same runtime, so either can install it with no `dsh plugin allow-version` exemption |
| Protocol | OneBot v11 reverse WebSocket. NapCat is the primary validation target (OCR, albums, group files, group check-in and join notices use NapCat-specific APIs and stop working on other implementations); LLOneBot / OpenShamrock / Lagrange and friends should work by protocol but have not been verified one by one |
| Node / ffmpeg | Node ≥ 22.13 (`node:sqlite` no longer needs `--experimental-sqlite`; validated on v24.9.0); ffmpeg optional but recommended (voice → 16 kHz WAV, GIF first frame, image compression, local TTS → mp3) — point `ffmpegPath` at it when it is not on PATH |
| Ports | 6700 (OneBot reverse WS), 8799 (console), 8798 (permission console, which is also the default inbound webhook port — do not run both on defaults), 6099 (NapCat WebUI), 9880 (local GPT-SoVITS) |

Only one instance per machine may host the QQ bridge: the web host and the desktop client fight over the same 6700, only one binds, and the other retries every 15 seconds and takes over once the port frees. Do not try to run both by giving one profile another port — they share the same data directory and will overwrite each other's state.

## FAQ

**1. The bot is online but never answers.** First check whether it is answering on purpose: an empty allowlist (refuse everything), no @-mention in groups, a client that sends the @ as plain text without `mentionAliases` covering it, or `quietHoursEnabled` in effect. Send `/health` for the runtime state, or open the console's live event stream filtered to "denied/failed" — every frame carries a Chinese reason (for example `mention: 群聊未 @ 机器人`).

**2. The log says port 6700 is taken (EADDRINUSE).** This is not a crash: another instance on the same machine (CLI host / desktop client) is hosting the QQ bridge. This instance reports the real reason and retries every 15 seconds, taking over once the holder exits. To pin hosting to one of them, **enable the plugin in only one profile** instead of changing the port.

**3. NapCat will not connect / where is the QR code?** The reverse WS address is `ws://127.0.0.1:6700/` (not 6099), and `accessToken` must match on both sides. The QR code lives in NapCat's WebUI (6099); the console's QR card prefers the local `cache/qrcode.png` written by the official native installer and only falls back to `docker cp` for container deployments; the「QQ助手」panel in DSH Settings also has a "QQ助手账号 (login / QR)" shortcut.

**4. The console will not start.** When 8799 is taken it reports "port already in use" and exits with code 2: `node control/bin/qq-control.mjs --port 8800`. Note that `webhookPort` also defaults to 8798, the same as the permission console — change one of them if you need both.

**5. A command is refused as unauthorised, or the bot is read-only.** The default role is guest: read-only and confined to its own directory, while file writes and shell are reserved for `owner`/`admin` (configure them in `identity.map`, `identity.groupRoles` or `adminUsers`). With `aclEnabled` the `acl.db` is authoritative — use the permission console to see what a subject actually holds instead of guessing at the config.

**6. What do speech-to-text, TTS and image generation need?** Transcription defaults to the local recogniser shipped with DSH (`sttProvider: dsh`): enable the experimental "voice input" bundle in the profile, and the model downloads on first use; switch to `cloud` to point at your own endpoint. TTS and image generation are **not shipped by DSH or by this plugin** — bring a service or a key; until then the features stay off and failures are written to the trace instead of being swallowed.

## Development and testing

Tests are plain scripts; most do not start a host or use the network, and they work in temporary directories:

```sh
npm test                                   # default entry: console HTTP / health check / port logic
npm run verify                             # pre-publish gate: control-unit + privacy-unit (scans for real QQ ids / keys)
node test/<name>-unit.mjs                  # unit tests by topic: commands-unit / trace-unit / inbox-unit / acl-unit …
npm run test:acl                           # the permission chain (acl / store / console / gates / enforcement / corpus)
node test/replay-live.mjs                  # real bridge code + a real OneBot server, sandboxed and dry-run, no host needed
node test/live-e2e.mjs                     # live: needs a running host (it acts as the OneBot client on 6700)
node test/live-stream.mjs                  # live: console event stream / decision chains / health endpoint
node test/replay-live-host.mjs --token <console token>   # record → offline replay → inject
```

`test/*-unit.mjs` covers pure logic and temporary directories, and `test/sim-*.mjs` are the older protocol simulation scripts, still useful for manual triage (they need a running host). `test/static-unit.mjs` enforces static constraints (bare imports, peer version lines, …) and `test/privacy-unit.mjs` scans tracked files for real QQ ids and secrets — run at least those two plus the matching topic tests after a change.

## Risk and compliance

- This plugin reaches QQ through **third-party protocol implementations** (NapCat and friends), which are not official Tencent APIs and conflict with the QQ licence agreement; accounts risk restricted login, freezing and permanent bans, and other accounts on the same device or IP can be affected. **Use a spare account, never your main one.**
- Everything the agent generates is posted as the bot account: the operator carries full responsibility. Keep it to personal learning and small private use — no bulk marketing, advertising, harassment or bot farming.
- The plugin binds `127.0.0.1` only; do not change it to `0.0.0.0` for remote access — what you would expose is your bot account. Cloud transcription (`sttProvider: cloud`) uploads audio to a third party, so do not send sensitive voice; the same applies to image generation and TTS. Using third-party protocols is **at your own risk**; no ban-free guarantee is offered. See [LICENSE](LICENSE) for the full statement.

## Origin and credits

This project is **derived from** [cheesehaqi/dsh-qq-onebot-bridge](https://github.com/cheesehaqi/dsh-qq-onebot-bridge) (upstream baseline v0.6.3) and continues development on top of it: the standalone console and permission model (ACL / SQLite), roles and session ownership, per-subject directory isolation, the data-root layout and container deployment — see [CHANGELOG.md](CHANGELOG.md) and [LOCAL-PATCH.md](LOCAL-PATCH.md) for the itemised changes. It is released under MIT (see [LICENSE](LICENSE); the copyright notice reads `dsh-qq-onebot-bridge contributors`), and the upstream copyright and licence notices are retained.Dependencies and thanks: [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (plugin host and agent runtime), [NapCat](https://github.com/NapNeko/NapCatQQ) (QQ protocol side and primary validation target) and [OneBot v11](https://github.com/botuniverse/onebot-11) (the protocol specification).


## Links

- [CHANGELOG.md](CHANGELOG.md) — per-release record and defect lists (currently v0.7.3); [LOCAL-PATCH.md](LOCAL-PATCH.md) — local changes, persona / identity / workspace notes
- [examples/cordis.patch.example.yml](examples/cordis.patch.example.yml) — full configuration example
- [NapCat docs](https://doc.napneko.icu/) · [OneBot v11 specification](https://github.com/botuniverse/onebot-11); Deployment package [zfqxuz/qqbot-deploy](https://github.com/zfqxuz/qqbot-deploy) (Docker / one-line host install; includes `HOST-INSTALL.md` and `UPDATE-UNINSTALL.md`)
