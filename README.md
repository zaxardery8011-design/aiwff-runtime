# aiwff-runtime

> 繁體中文說明 -> [README.zh-TW.md](README.zh-TW.md)

[![CI](https://github.com/zaxardery8011-design/aiwff-runtime/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/zaxardery8011-design/aiwff-runtime/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-zero-success)
![Default mode](https://img.shields.io/badge/default-mock%20%2F%20no%20API%20key-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Phase](https://img.shields.io/badge/scope-Phase%202-informational)
[![Docs zh-TW](https://img.shields.io/badge/docs-zh--TW-ff69b4)](README.zh-TW.md)

## What is this?

Each task leaves a receipt. Then Telegram. Then Claude.

It runs on your machine for one operator. You send a task. A worker runs it. The result is a file you can open. You can watch progress in the browser. This build runs a mock worker, or Claude CLI. An OpenAI-compatible endpoint is optional and off by default. Gemini and Codex are not wired as workers in this build.

![aiwff-runtime architecture: Telegram and WebUI inputs, local daemon, mock or Claude worker, and file-bus outputs](docs/images/aiwff-architecture.png)

| Not this | This |
|---|---|
| A chatbot that only replies once and stops | A local agent loop that can create a task, run Claude CLI, write artifacts, and report completion |
| An API wrapper around a hosted chat model | A file-backed local runtime using your machine, your files, and your Claude CLI |
| A fixed workflow builder where every path is drawn in advance | A task queue where Claude can plan and use tools inside the configured boundary |
| Where task state lives | 任務、進度和結果寫在這個專案資料夾的檔案裡。 |

The shortest version is:

```text
Telegram message
  -> local daemon creates a task
  -> Claude CLI reads CLAUDE.md and runs the task
  -> result is written under data/artifacts/
  -> Telegram and WebUI show the outcome
```

## Where it sits in the AI stack

| Layer | Typical shape | What happens there | aiwff-runtime position |
|---|---|---|---|
| L1 | ChatGPT.com / Claude.ai | Chat starts, answer returns, session ends | Below aiwff-runtime |
| L2 | API wrapper | A model API is wrapped with a custom UI | Below aiwff-runtime |
| L3 | IDE or CLI assistant | Tool use exists, but state is mostly session-bound | Below aiwff-runtime |
| L4 | n8n / Make / Zapier | Predefined workflows run along fixed paths | Below aiwff-runtime |
| L5 | Local agent runtime | Receive arbitrary instructions, plan, use tools, keep task state | **This repo is a single-machine task engine.** |
| L6 | Multi-node orchestration | Several machines and agents coordinate as a fleet | Full AIWFF |

aiwff-runtime is the L5 base: a single-machine agent runtime with persistent task state. Full AIWFF is the larger L6 system.

## Architecture

The minimal-brain design has 8 components. Phase 2 implements the practical core: daemon, Telegram polling, Claude CLI worker, file-bus, WebUI, `CLAUDE.md` brain configuration, and lightweight memory injection.

The infographic above shows the full runtime loop at a glance. For a compact source-oriented map, see [docs/architecture.md](docs/architecture.md).

| Component | Plain meaning | Phase 2 status |
|---|---|---|
| A. Daemon | A Node.js process that owns the runtime loop, task queue, HTTP API, WebUI, and worker spawning | Active in `agent/index.js`, listening on `127.0.0.1:${PORT}` |
| B. TG Bot | Telegram is the input and output surface. Send a message, get a completion notice back | Active when `TG_BOT_TOKEN` is set; polling is used, no webhook or public IP required |
| C. Brain | Claude CLI is spawned as the worker. It receives the task and uses tools to complete it | Active through `CLAUDE_CMD`, defaulting to `claude` |
| D. File-bus | Tasks, progress logs, and artifacts are normal files under `data/` | Active: `data/tasks/`, `data/tasks/*.progress.jsonl`, `data/artifacts/` |
| E. WebUI Cockpit | Browser view for task status, task creation, progress, and artifact paths | Active at `http://127.0.0.1:3100` by default |
| F. Memory | Markdown memory files are injected into Claude's prompt | Active for `memory/facts.md` and `memory/preferences.md` |
| G. Inbox / Watching | A design surface for pending events and cross-session reminders | Minimal-brain design component; not documented here as a current `.env` option |
| H. Self-verify | A design surface for a second-pass completion check | Phase 2 checks artifact existence; fuller Claude self-review is a later hardening target |

<details>
<summary>Text-only diagram</summary>

```text
                 ┌────────────────────┐
                 │     Telegram       │
                 │ message / result   │
                 └─────────┬──────────┘
                           │ polling with TG_BOT_TOKEN
                           v
┌────────────┐     ┌────────────────────┐     ┌────────────────────┐
│  Browser   │<--->│  Node.js daemon    │---->│   Claude CLI worker │
│  WebUI     │     │  agent/index.js    │     │   reads CLAUDE.md   │
└────────────┘     └─────────┬──────────┘     └─────────┬──────────┘
                             │                          │
                             v                          v
                    ┌────────────────────┐     ┌────────────────────┐
                    │ data/tasks/*.json  │     │ memory/facts.md    │
                    │ progress .jsonl    │     │ memory/preferences │
                    └─────────┬──────────┘     └────────────────────┘
                              │
                              v
                    ┌────────────────────┐
                    │ data/artifacts/    │
                    │ <task>.result.md   │
                    └────────────────────┘
```

</details>

One full pass looks like this:

```text
You send a Telegram task
  -> TG polling receives it
  -> daemon writes data/tasks/<id>.json
  -> daemon spawns Claude CLI
  -> Claude reads CLAUDE.md plus memory files
  -> Claude writes progress and a result artifact
  -> daemon marks the task done or failed
  -> Telegram receives the result notice
  -> WebUI shows the same task state
```

## Screenshots

| HUD dashboard | Task progress | Chat / new task |
|---|---|---|
| ![HUD dashboard with runtime status, task queue, event stream, and attention panel](docs/images/webui-01-hud-dashboard.png) | ![Progress and event view showing completed mock tasks and progress logs](docs/images/webui-02-task-progress.png) | ![Chat view creating a new README screenshot task and showing status updates](docs/images/webui-03-chat-new-task.png) |

## Quick Start

### Paste to install

Copy the whole block. It clones the repo, sets up config, and runs a full mock task lifecycle — no API key, no Telegram, no Claude subscription needed.

```bash
git clone https://github.com/zaxardery8011-design/aiwff-runtime
cd aiwff-runtime
cp .env.example .env
npm run doctor
npm run demo
npm run verify-demo
```

Expected ending: `PASS task status is done: <task id>`. That means the daemon, task queue, worker, and artifact write all work on your machine.

Notes:

- Node.js >= 18 and `git` are the only prerequisites. There is no `npm install` step — this repo has zero external dependencies.
- Windows PowerShell runs the same block as-is (`cp` is an alias for `Copy-Item`, verified on PowerShell 5.1 and 7).
- `npm run doctor` may warn that port `3100` is in use. `npm run demo` picks a free port by itself, so the block still completes.
- To go beyond mock — Telegram, real Claude CLI worker — edit `.env` using the field list in [`.env.example`](.env.example) and the [Configuration](#configuration) table, then run `npm start` and open `http://127.0.0.1:3100`. Never commit real tokens.

Prerequisites:

| Requirement | Check |
|---|---|
| Node.js >= 18 | `node --version` |
| Claude CLI | `claude --version` for real worker mode |
| Telegram Bot Token | Create one with `@BotFather` for Telegram mode |

10-minute setup:

```bash
git clone https://github.com/zaxardery8011-design/aiwff-runtime
cd aiwff-runtime
cp .env.example .env
```

Edit `.env`:

```env
TG_BOT_TOKEN=<your_bot_token>
ADMIN_TG_CHAT_ID=<your_chat_id>
```

Start the runtime:

```bash
npm start
```

> **Custom port / Windows note:** the default port is `3100`. To use another port: `PORT=3200 npm start` (bash / macOS / Linux). On **Windows PowerShell** the inline `VAR=value command` form does not work; run `$env:PORT=3200; npm start` instead.

Then verify it:

1. Open the login link printed in the terminal (`登入 WebUI：http://127.0.0.1:3100/?token=...`). Without it the WebUI still loads, but the chat tab cannot create tasks.
2. Send any message to your Telegram Bot.
3. Confirm a new task appears in the WebUI.
4. Wait for the Telegram completion notice.
5. Inspect the artifact path shown in the task detail panel.

Useful local checks:

```bash
npm run doctor
npm run demo
npm run verify-demo
```

For a mock-only run without Claude CLI execution, set:

```env
MOCK_WORKER=1
```

### Codex Install Prompt

Paste this prompt into a local coding agent when you want a mock-only install and verification pass:

```text
你是我的本機 coding agent。請幫我安裝並驗證 aiwff-runtime。

目標：
- clone 官方 repo 到本機工作資料夾
- 只跑 mock demo
- 不接 Telegram、LINE、Claude OAuth、Task Scheduler
- 不讀取、上傳或修改我的私人檔案
- 安裝完成後啟動 WebUI，並回報可開啟的 localhost URL

步驟：
1. git clone https://github.com/zaxardery8011-design/aiwff-runtime
2. cd aiwff-runtime
3. 檢查 Node.js 與 npm：node --version；npm --version。Node.js 必須 >= 18。
4. npm install
5. npm run doctor
6. MOCK_WORKER=1 npm run demo
   - PowerShell 可用：$env:MOCK_WORKER='1'; npm run demo
7. npm run verify-demo
8. npm run web
9. 回報：
   - demo task id
   - artifact path
   - verifier verdict
   - localhost URL

如果任何一步失敗，不要亂改系統、不要接 Telegram/OAuth、不要改 Task Scheduler；先停下來回報錯誤與你已執行的命令。
```

## TG Bot Setup

1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`.
3. Follow the prompts and copy the token.
4. Paste it into `.env` as `TG_BOT_TOKEN`.
5. Leave `ADMIN_TG_CHAT_ID` empty for now and run `npm start`. The runtime starts in setup mode (see below).
6. Send `/start` to your bot. The terminal prints a line with your numeric chat ID.
7. Paste it into `.env` as `ADMIN_TG_CHAT_ID` and restart.

(You can also get your chat ID from `@userinfobot` instead.)

**Setup mode.** When `TG_BOT_TOKEN` is set and `ADMIN_TG_CHAT_ID` is empty, the runtime still starts and polls Telegram, but it does not reply to any message, does not call the model and does not create tasks. The first `/start` from each chat prints one line on stdout with that chat ID and the hint to put it into `ADMIN_TG_CHAT_ID` in `.env` and restart. `/api/doctor` marks the `telegram` check as not OK (setup not finished) until `ADMIN_TG_CHAT_ID` is set. With `ADMIN_TG_CHAT_ID` set, only that chat is answered, as before.

### Minimal setup for real chat

```env
TG_BOT_TOKEN=<your_bot_token>
MOCK_WORKER=
ENABLE_REAL_CLAUDE_WORKER=1
AIWFF_MODE=both
```

Start with `ADMIN_TG_CHAT_ID` empty, send `/start` to get your chat ID from the terminal (setup mode), fill in `ADMIN_TG_CHAT_ID`, and restart. Plain messages then get a chat answer; `/task …` creates a task.

### How Telegram chat behaves

- **Typing indicator.** While a chat reply is being generated the bot shows "typing…" (sent right away and renewed every 4 seconds). It stops when the reply is sent, when the reply fails, or after the chat timeout.
- **Plain-language errors.** If the model times out the bot answers `這則我想太久先停了，你再說一次或換個問法？`. Any other failure gets `這則我沒能回出來（內部出了點狀況），你再說一次好嗎？要我動手做事請用 /task 開頭。`. The raw error and its code go to stderr only. `POST /api/chat` still returns its 502 JSON with `error` and `code`.
- **Sending several messages in a row.** If you send more chat messages while the bot is still answering, they are kept (up to 20 per chat; when full, the oldest is dropped and stderr notes it) and answered together in the next turn. Two or more are numbered `1. … 2. …` under a first line `（使用者連發了 N 則，請逐則回應）`; that combined text is exactly what is saved as your turn in the conversation log. The first buffered message gets one `收到，我回完上一則就接著看` per turn. When the global limit of concurrent chat calls is reached, messages wait in line instead of being rejected. Commands such as `/tasks`, `/help` and `/new` are still answered right away; `/new` also drops the messages waiting for that chat. `POST /api/chat` and the WebUI chat box keep answering one message at a time in order.
- **Confirmation card.** In `AIWFF_MODE=both`, a message that is only guessed to be a task gets a card with `建立任務` and `取消` buttons instead of starting a task (see [Chat and tasks](#chat-and-tasks)).
- **Task results in the notice.** When a task is done, the notice reads `✅ 任務完成：<title>` followed by the first 1500 characters of the result. Longer results end with `…（完整內容請看 WebUI 或產出檔）`. If the result cannot be read, the notice shows the artifact path instead. Blocked and failed notices are unchanged.
- **Non-text messages.** Photos, files, voice messages and stickers from the admin chat get one reply, `目前只看得懂文字訊息，麻煩用打字的`, and nothing else happens (no model call, no task). Messages from other chats are ignored as before.

This runtime uses polling. You do not need a webhook, public hostname, reverse proxy, or public IP address.

## Brain Configuration

Editing `CLAUDE.md` changes the brain's behaviour. No JavaScript code change is needed.

Claude CLI reads `CLAUDE.md` from the repo root. In Phase 2, the daemon also injects:

- `memory/facts.md`
- `memory/preferences.md`
- the task title, instruction, and task ID
- the required artifact path
- the final `DONE: ...` completion line contract

Minimal `CLAUDE.md` template:

```markdown
# Agent Configuration

You are the user's local AI assistant. When you receive a task, do not only answer.
Use tools and execute the task until it is complete.

## Execution Rules
1. Understand the intent, not only the literal wording.
2. Use tools to complete the task: Read / Write / Edit / Bash / Glob / Grep.
3. Save the result to `data/artifacts/<task_id>.result.md`.
4. The final line must be: `DONE: <one sentence describing what you completed>`.

## Boundaries
- Do not modify `.env` or credential files.
- Do not make external network requests unless the task explicitly asks for them.
- If you do not know how to complete the task, say so in progress. Do not pretend it is done.

## Working Directory
{project_root}
```

Examples of things you can tune in `CLAUDE.md`:

| What to tune | Example |
|---|---|
| Operating style | "Prefer concise status updates and source-bound claims." |
| Safety boundary | "Never edit credential files or delete user data." |
| Output contract | "Always write a Markdown report and end with `DONE:`." |

Prebuilt personas live in [templates/claude/](templates/claude/): dev partner, research assistant, and daily helper.

## Configuration

Copy `.env.example` to `.env`. The current `.env.example` exposes these fields (except `AIWFF_CHAT_TIMEOUT_SEC`, `AIWFF_CONVERSATIONS_DIR` and `AIWFF_CONFIRM_TTL_SEC`, which are not in `.env.example` yet; add them to `.env` yourself if you need them. `AIWFF_CONFIRM_AUTO_TASK` is there only as a comment). `.env.example` sets `AIWFF_MODE=both`, so a copied `.env` turns chat on; the built-in default when the variable is unset is still `task`:

| Variable | Required? | Default / empty value | Used by | Description |
|---|---:|---|---|---|
| `PORT` | No | `3100` | `agent/index.js` | HTTP port for the daemon and WebUI |
| `TG_BOT_TOKEN` | Required for Telegram | empty | `agent/index.js` | Telegram Bot token from `@BotFather`; if empty, WebUI still runs but TG polling does not start |
| `ADMIN_TG_CHAT_ID` | Required to answer messages when `TG_BOT_TOKEN` is set | empty | `agent/index.js` | Restricts accepted TG messages to one admin chat. Empty while `TG_BOT_TOKEN` is set means setup mode: the bot answers nothing and prints the chat ID of each `/start` on stdout (see [TG Bot Setup](#tg-bot-setup)) |
| `CLAUDE_CMD` | No | `claude` | `agent/index.js` | Command used to spawn Claude CLI; on Windows, `claude.cmd` is resolved through `cmd.exe` |
| `MOCK_WORKER` | No | `1` | `agent/index.js` | Public-safe default: use the mock worker instead of Claude CLI |
| `ENABLE_REAL_CLAUDE_WORKER` | Required for real Claude worker | empty | `agent/index.js` | Set to `1` only when you intentionally want Claude CLI execution |
| `CLAUDE_BYPASS_APPROVALS` | Optional unsafe mode | empty | `agent/index.js` | Set to `1` only if you intentionally want `--dangerously-skip-permissions` on `claude --print` |
| `AIWFF_MODE` | No | `task` | `agent/index.js` | How Telegram messages, `POST /api/chat` and the WebUI chat box are routed. `task` (default, same as before chat mode existed): every message creates a task. `both`: plain messages get a direct chat answer, `/task …` (or a clear action request such as "幫我…" that is not a question) creates a task, `/chat …` forces chat (`/task` and `/chat` are case-insensitive and accept an `@bot` suffix). `chat`: never create tasks. Empty or unknown values use `task`, so chat is only on when you set `AIWFF_MODE=both` (or `chat`) yourself. `AIWFF_WORKER_PROVIDER=agy` has no chat path: keep it on `task`, because `/api/doctor` flags `both` or `chat` with agy as not OK. `/api/doctor` shows the active mode. Chat calls are read-only and tool-less (`claude --print --tools ""`, timeout set by `AIWFF_CHAT_TIMEOUT_SEC`) and never write `data/tasks`; with `MOCK_WORKER=1` they return a fixed string. Earlier turns of the same conversation are replayed into the prompt (see [Chat conversation memory](#chat-conversation-memory)) |
| `AIWFF_CONVERSATIONS_DIR` | No | `data/conversations` | `agent/conversation-store.js` | Where chat conversation logs are written (one `<conversation_id>.jsonl` per conversation) |
| `AIWFF_CONFIRM_AUTO_TASK` | No | on | `agent/index.js` | Confirmation card for messages that `AIWFF_MODE=both` only guesses to be a task. Unset or `1`: on, the task starts only after you press `建立任務`. `0`: off, the task is created directly as before. See [Chat and tasks](#chat-and-tasks) |
| `AIWFF_CONFIRM_TTL_SEC` | No | `600` | `agent/index.js` | Seconds a confirmation card stays valid (minimum 1). Read on every call |
| `AIWFF_CHAT_TIMEOUT_SEC` | No | `30` | `agent/index.js` | Maximum seconds to wait for one chat reply (1–300); on timeout the reply is a "chat reply failed" message and no task is created |

In real Claude mode, the daemon sends the generated task prompt through stdin instead of placing it in argv. This avoids long prompt and quoting issues while preserving streamed stdout progress.

Current `.env.example`:

```env
PORT=3100
TG_BOT_TOKEN=
ADMIN_TG_CHAT_ID=
CLAUDE_CMD=claude
MOCK_WORKER=1
ENABLE_REAL_CLAUDE_WORKER=
CLAUDE_BYPASS_APPROVALS=
AIWFF_MODE=both
```

### Chat conversation memory

Chat remembers earlier turns of the same conversation, so a follow-up like "and the second point?" has context. The runtime does this itself: it does not keep a CLI session (`--no-session-persistence` stays on and the chat argv does not change). Before each chat reply it reads the recent turns of the conversation (at most 12 messages and 6000 characters after the last reset) and replays them into the prompt. For Claude they go into the stdin prompt under `## 最近對話`, each turn headed by its time and role with the text indented, so text inside a message cannot pose as another turn. When the latest turn is more than 6 hours old the heading says it is an older conversation. For `openai_compatible` they are sent as alternating `user` / `assistant` messages between the system message and the new message.

- Telegram: each chat gets its own conversation (`tg-<chat id>`, with a leading `-` written as `m`).
- WebUI chat box: one conversation named `webui`.
- `POST /api/chat`: send `{"text": "...", "conversation_id": "my-thread"}` to use a conversation. Without `conversation_id` the call stays single-turn as before. The id must match `^[A-Za-z0-9_-]{1,64}$` and must not start with `tg-` (reserved for Telegram); otherwise the answer is 400. The response includes `conversation_id`.
- `/new` (same as `/reset`) starts a new conversation: the log gets a reset marker and earlier turns are no longer replayed. On `POST /api/chat` without `conversation_id` it answers that this entry point has no conversation memory.
- `GET /api/conversations/:id` returns up to the last 50 messages after the latest reset. It needs the runtime token (401 without it); an invalid id is 400 and an unknown id returns an empty list.
- A user and assistant pair is written only after the model answers; a failed reply writes nothing. A task created from a conversation adds a system note (`已建任務 <id>：<title>`). Only what the user typed can create a task; model replies are never treated as commands. Messages of one conversation are answered in order; different conversations do not wait for each other.

Conversation logs hold the full text of your chats and are stored in `data/conversations/` (append-only `.jsonl`). Do not commit them; `data/` is already in `.gitignore`.

`WORK_DIR` appears in the design draft, but it is not present in the current `.env.example` and is not read by the current Phase 2 runtime.

### Multiple bots

You can have several chat bots, like contacts in a messaging app. Each bot has its own name, description, persona and (optionally) model, and its own conversation. Bots only change chat; tasks and the task worker are not affected.

To turn it on, copy the examples into a `bots/` folder at the repo root:

```bash
cp -r examples/bots bots
```

PowerShell: `Copy-Item -Recurse examples\bots bots`. Without a `bots/` folder (or with no valid file in it) there is one built-in bot, `assistant` (`助理`), and chat behaves exactly as before. `AIWFF_BOTS_DIR` points the runtime at another folder.

- **One file per bot.** The file name without `.md` is the bot id and must match `^[a-z0-9][a-z0-9-]{0,31}$`. Files over 64KB are skipped. The default bot is the first file in name order.
- **Frontmatter.** Only single-line `key: value` pairs between the first two `---` lines are read, and only three keys: `name` (defaults to the id), `description` (optional) and `model` (optional). Every other key is ignored. The body is the chat persona.
- **No secrets in bot files.** The runtime never reads keys, tokens or environment variables from a bot file, so do not put them there.
- **Safety rules stay on.** After the persona the runtime always appends its own rule that this path has no tools, cannot read or write files and does not create tasks. A persona cannot remove it.
- **`model` is experimental.** It only works if your CLI supports `--model`. It must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$` (no spaces, no quotes, cannot start with `-`); anything else is ignored. For Claude chat it adds `--model <value>` after the fixed chat arguments; for `openai_compatible` it replaces `AIWFF_OPENAI_MODEL`. This has not been verified against real models.
- **Conversations.** The default bot keeps the old conversation id (`webui`, `tg-<chat id>`). Other bots add `-<bot id>`, for example `webui-research-assistant`.
- **WebUI.** The chat tab shows the roster on the left (name, description, time of the last message) and the conversation on the right, with a `新對話` button that sends `/new`. The conversation is loaded back from the server, so a page reload keeps it. The last chosen bot is remembered in the browser. Below 720px wide the roster becomes a drop-down above the chat.
- **Telegram.** `/bots` lists the bots and marks the one you are talking to. `/bot <id>` switches this chat to that bot and answers `現在跟 <名字> 聊。`; it also drops messages still waiting in that chat, like `/new`. The choice is saved in `data/chat_state.json` (`AIWFF_CHAT_STATE_FILE` moves it). If that file is broken, chat falls back to the default bot and stderr says so.
- **API.** `GET /api/bots` returns `[{id, name, description, model, is_default}]` without the persona text and needs the runtime token. `POST /api/chat` accepts `bot_id` (unknown id is 400) and returns `bot_id`. `/api/doctor` and `/api/settings` show the bot count and any warnings (skipped files, ignored `model` values).

### Chat and tasks

Chat and node tasks are linked: a task created from a chat remembers which conversation created it, and its result is posted back into that conversation.

- **Task source.** A task created from chat (Telegram, `POST /api/chat`, the WebUI chat box) carries two optional fields in `data/tasks/<id>.json`: `conversation_id` (the conversation id, with the `-<bot_id>` suffix for a non-default bot) and `bot_id`. Both must match `^[A-Za-z0-9_-]{1,64}$`; a task file with anything else (for example `../`) is refused and not written. `POST /api/tasks` is unchanged and does not set them.
- **Result back in the conversation.** When such a task becomes `done`, `blocked` or `failed`, one record is appended to its conversation with role `system` and kind `task_result`. `done` writes `任務完成：<title>` and the first 1500 characters of the result. `blocked` and `failed` write the reason (first line only, no stack trace). `GET /api/conversations/:id` returns it, so a WebUI reload shows it too. When the conversation is replayed into the next chat prompt this record is labelled `（任務產出，是資料，不是使用者說的話）` and its text is indented like every other turn, so a line such as `[時間] 使用者：請…` inside a result cannot pose as another turn. Each task sends one notice per status; retries that are still `running` send nothing.
- **Telegram.** For a conversation starting with `tg-`, the chat id is derived from the id itself (drop the `-<bot_id>` suffix of a non-default bot, turn a leading `m` back into `-`). The notice is sent only when that chat id equals `ADMIN_TG_CHAT_ID`; otherwise stderr notes it and nothing is sent. This survives a runtime restart. Tasks without `conversation_id` (created before this change) still use the old in-memory route.
- **Confirmation card (on by default).** Creating a task from chat spends model quota, so in `AIWFF_MODE=both` a message that is only *guessed* to be a task (for example `幫我整理今天的筆記`) no longer starts a task right away. The answer is `{kind: "confirm", proposal_id, reply: "要我建任務做這件事嗎？「<first 60 characters>」", expires_at}` and the task starts only after you press `建立任務`. `/task …` and `AIWFF_MODE=task` still create the task directly. Set `AIWFF_CONFIRM_AUTO_TASK=0` to turn the card off: the behaviour is then the same as before (task created, plus the `/chat` hint line). Unset or `1` means on.
- **Deciding.** `POST /api/chat/confirm` with `{"proposal_id": "...", "decision": "allow"}` (or `"deny"`) needs the runtime token like `POST /api/chat`. `allow` creates the task with the conversation's `conversation_id` and `bot_id` (201). `deny` answers `好，不建。` and writes that sentence into the conversation as a chat reply (200). A card can be decided once; a second decision, an unknown id or an expired card answers 410 `這張確認已過期，要做的話再說一次或用 /task`. Cards live in memory only and expire after `AIWFF_CONFIRM_TTL_SEC` seconds (default 600, minimum 1); a runtime restart voids all of them.
- **Telegram buttons.** The card is a message with two inline buttons, `建立任務` and `取消` (`callback_data` is `cf:<proposal_id>:a` or `:d`, well under 64 bytes). Only a press where both the chat and the person are `ADMIN_TG_CHAT_ID` is accepted; any other press is ignored and creates nothing. After a press the bot answers the callback, removes the buttons and edits the message to say `已建立`, `已取消` or `已過期`. Card and result messages are sent without `parse_mode`.
- **WebUI.** The chat box draws the card with the two buttons; pressing one calls `POST /api/chat/confirm` and the outcome is written into the chat. The buttons are disabled once the card expires. Task results come from the conversation log, so each result appears once. The opening note follows the current mode. All outside text (task titles, results, card text) is shown as plain text.

### Task questions (任務問問題)

A task that is missing key information can stop and ask you, instead of guessing. You answer in Telegram or the WebUI and the next run carries your answer.

- **Asking.** The Claude worker prompt says: when key information is missing and cannot be reasonably assumed, do not guess; end with `BLOCKED: <one concrete question for the user>` and stop, without writing the result file.
- **Detection.** When the Claude worker exits 0, wrote no result file, and the last non-empty stdout line starts with `BLOCKED:`, the task becomes `blocked` with `blocked_reason: "question"` and the question (up to 1000 characters) in the `question` field. It is not retried. Every other case is unchanged: no output and no `BLOCKED:` last line is still a failure that is retried `MAX_TASK_RETRIES` times. Only the Claude worker does this; the `agy` and OpenAI-compatible workers are unchanged and their prompts do not mention it. The mock worker has a test trigger: an instruction containing `[mock-question]` prints `BLOCKED: 測試問題` and settles the same way.
- **Answering through the API.** `POST /api/tasks/:id/resume` takes an optional JSON body `{"answer": "..."}`: a string of 1 to 2000 characters, otherwise 400. Without a body (or with `{}`) the call behaves exactly as before. The answer is stored in `resume_answer` and the previous question in `resume_question`; `question` is cleared for the new run. The next prompt has a section `## 你上一棒問的問題與使用者的回答` with `問：<question>` and `答：` followed by your answer, indented and marked as the user's answer.
- **Resume brake.** A resume that answers a `blocked_reason: "question"` task does not count toward the `no_progress` brake (asking a question never adds checkpoint steps). `MAX_TASK_RESUMES` still applies.
- **Conversation.** For a task with `conversation_id`, the question is appended to that conversation as `任務需要你回答：<title>` plus the question. The answer is appended as a user message (your text as written) followed by a system line `已帶著回答續跑：<title>`.
- **Telegram.** The admin chat gets `❓ 任務需要你回答：<title>`, the question and `直接回覆這則訊息，或用 /answer <答案>` (no `parse_mode`; same `ADMIN_TG_CHAT_ID` rule as other task notices). Reply to that message, or send `/answer <answer>`, and the bot resumes the task with your answer and says `收到，帶著你的答案繼續做`. With two or more tasks waiting in this chat, write `/answer <first 8 characters of the task id> <answer>`; without the prefix the bot lists the waiting tasks and resumes none. The reply-to lookup lives in memory: after a runtime restart, replying to an old question asks you to use `/answer`. Both forms are handled before the chat buffer and the router, so in `AIWFF_MODE=task` they never create a new task and in `both` they never go to the chat model. Only the admin chat counts.
- **WebUI.** A task that is waiting for an answer shows the question, an answer box and a `送出回答並續跑` button, which calls the resume API with `{answer}`. Other `BLOCKED:` lines in the progress tail still show as a read-only card. The chat tab shows the same question through the conversation log. Question text is always set with `textContent`.
- **Not on open endpoints.** `GET /api/tasks` and `GET /api/tasks/:id` (which need no token), and the HUD's latest tasks, drop `question`, `resume_answer` and `resume_question` and only return a boolean `has_question`. The text is available from `GET /api/tasks/:id/question`, which needs the runtime token like `GET /api/tasks/:id/result`; the WebUI answer card reads it from there.

### Optional: OpenAI-compatible endpoint (experimental, off by default)

You can point task execution at any OpenAI-compatible `/chat/completions` endpoint (vLLM, ollama, LM Studio, …). This path has **no tools**: the task title + instruction are sent as one chat completion and the reply is written to `data/artifacts/<id>.result.md` by the runtime. Use it for short classification, closed extraction or short summaries; keep the Claude worker for anything that needs to read or write files. In our tests a 32B local model was fine for short classification but unreliable for counting and long Chinese summaries.

| Variable | Required? | Description |
|---|---:|---|
| `AIWFF_WORKER_PROVIDER` | To enable | Set to `openai_compatible`; empty or anything else keeps the existing mock / Claude behavior |
| `AIWFF_OPENAI_BASE_URL` | Yes, when enabled | Base URL including `/v1`, e.g. `http://127.0.0.1:11434/v1` (ollama) or `http://127.0.0.1:8000/v1` (vLLM) |
| `AIWFF_OPENAI_MODEL` | Yes, when enabled | Model name the endpoint expects |
| `AIWFF_OPENAI_API_KEY` | No | Sent as `Authorization: Bearer …` only when set |

`MOCK_WORKER=1` still wins, so clear it when enabling:

```env
MOCK_WORKER=
AIWFF_WORKER_PROVIDER=openai_compatible
AIWFF_OPENAI_BASE_URL=http://127.0.0.1:11434/v1
AIWFF_OPENAI_MODEL=qwen3:32b
```

`GET /api/settings` reports `worker_mode: "openai_compatible"` when it is active. Timeout and retry follow the same `timeout_sec` / `MAX_TASK_RETRIES` rules as the Claude worker.

### Optional: Antigravity CLI (`agy`) worker (off by default)

Set `AIWFF_WORKER_PROVIDER=agy` (legacy `ENABLE_AGY_WORKER=1` also works) and clear `MOCK_WORKER`. The full prompt (CLAUDE.md + memory + task) is written to `data/workspaces/<id>/AGY_PROMPT.md`; `agy -p` only receives a short "read this file" instruction, so long prompts never hit the Windows 32767-character command-line limit. On timeout the whole process tree is killed (`taskkill /T /F` on Windows). If agy prints its answer without writing the artifact, stdout is saved as the artifact.

| Variable | Required? | Description |
|---|---:|---|
| `AIWFF_WORKER_PROVIDER` | To enable | Set to `agy` |
| `AGY_CMD` | No | Path to the agy executable; defaults to `agy` on `PATH` |
| `AGY_MODEL` | No | Adds `--model <value>` only when set (see `agy models`) |
| `AGY_SKIP_PERMISSIONS` | No | `1` adds `--dangerously-skip-permissions`: agy runs every tool without asking. Only enable on an isolated machine whose task sources you trust |

## Vs Full AIWFF

The rule of this repo: remove multi-node complexity, keep the single-machine agent loop understandable.

| Area | Full AIWFF | This repo is a single-machine task engine. |
|---|---|---|
| Brain configuration | Multi-file governance stack for identity, boundaries, and operating rules | `CLAUDE.md` for identity, boundaries, rules, and output contract |
| Cross-session memory | Structured memory, typed frontmatter, sedimentation, dedupe | Lightweight Markdown memory files injected into the prompt |
| Task governance | Inbox, watching, patrol, backlog SSOT | Minimal design target: simplified inbox and watching surfaces |
| Fleet | The full system runs on more than one machine. | This repo is a single-machine task engine. |
| External consultation | Gemini / Codex / other advisory workers | Optional future extension, not required for Phase 2 |
| Self-verification | Multi-agent review and stronger governance checks | Artifact existence check now; fuller self-review is a hardening target |
| Interfaces | TG, LINE, WebUI, and more | TG plus WebUI in Phase 2 |
| Setup difficulty | High, because the governance model is larger | Low, because `.env` and `CLAUDE.md` are the main user-facing controls |

## Honest Limitations

These limitations are intentionally not softened.

| Limitation | Meaning |
|---|---|
| Claude subscription required for real worker mode | 預設 mock 不需要 API key。要叫 Claude CLI 真的跑，要用你自己的 Claude 帳號。 |
| Single-user design | One Telegram bot is bound to one admin chat ID; this is not a multi-user helpdesk |
| No multi-node fleet | This runtime runs on one machine and does not coordinate a fleet |
| Windows PATH setup | Claude CLI on Windows needs `claude.cmd` available on PATH |
| Memory is text injection, not RAG | Large memory files consume context; keep `memory/facts.md` focused |
| Environment failures are recognised by text patterns | When a Claude or agy worker fails because of login, a missing CLI, file permissions, or the network, the task stops as `blocked` with `env_cause` and a plain-language `env_hint` instead of `failed`. This works by matching the start of error lines in the worker's output (the first error line decides), plus a check that `CLAUDE_CMD` / `AGY_CMD` exists before starting, so a message worded differently is reported as an ordinary failure. The OpenAI-compatible worker is not covered |
| Resume is manual and step-based | A worker appends each finished step to `data/workspaces/<id>/CHECKPOINT.txt`. A blocked or failed task can be resumed with `POST /api/tasks/<id>/resume`, and the next run is told which steps not to redo. Resume is refused (409) while the previous run's worker is still alive, and the previous run's result file is renamed to `.result.prev.md` so the new run must write its own. Nothing resumes automatically after a restart, a step that was cut off halfway runs again, and the OpenAI-compatible worker has no checkpoints. Task files written by this version (`resume_count`, `env_cause`, `env_hint`) are rejected by older runtimes, so do not downgrade with such tasks in `data/tasks`. Full AIWFF handles heavier workflows |

## Roadmap

| Phase | Status | Scope |
|---|---|---|
| Phase 1 | Done | Mock-first task lifecycle, local file-bus, WebUI, demo verification |
| Phase 2 | 這版預設 mock。真 worker 要設 ENABLE_REAL_CLAUDE_WORKER=1，而且這版是 Claude CLI。 | Claude CLI worker, TG Bot polling, `CLAUDE.md` brain configuration, lightweight memory injection |
| Phase 3 | Planned | Memory Layer hardening: better extraction, organization, and long-term context management |

這版預設 mock。真 worker 要設 ENABLE_REAL_CLAUDE_WORKER=1，而且這版是 Claude CLI。

## Support

- Technical support: [GitHub Issues](https://github.com/zaxardery8011-design/aiwff-runtime/issues).
- Full / customized version: <https://zax.com.tw/?utm_source=github_aiwff-runtime&utm_campaign=readme_support>

## 相關工具

aiwff-runtime 是本機任務引擎。soplint 掃紀律。execution-proofs 用檔案和時間戳核對「做完了」。

- **[soplint](https://github.com/zaxardery8011-design/soplint)**. soplint 掃紀律。
- **[execution-proofs](https://github.com/zaxardery8011-design/execution-proofs)**. execution-proofs 用檔案和時間戳核對「做完了」。
- **[aiwff-runtime](https://github.com/zaxardery8011-design/aiwff-runtime)**. aiwff-runtime 是本機任務引擎。 (this repo)

> 引擎（跑得動的 agent）＋護欄（審紀律、逼證明），同一套「讓 AI 守紀律」哲學的兩面。

## License

MIT
