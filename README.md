# aiwff-runtime

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)]()

## What is this?

aiwff-runtime is a local minimal brain for personal AI work: send a message to Telegram, Claude runs on your machine autonomously, the result is pushed back to you, and you can watch progress in the browser.

It is designed for a single local operator who wants an agent runtime, not just another chat surface.

| Not this | This |
|---|---|
| ✗ A chatbot that only replies once and stops | ✓ A local agent loop that can create a task, run Claude CLI, write artifacts, and report completion |
| ✗ An API wrapper around a hosted chat model | ✓ A file-backed local runtime using your machine, your files, and your Claude CLI |
| ✗ A fixed workflow builder where every path is drawn in advance | ✓ A task queue where Claude can plan and use tools inside the configured boundary |
| ✗ A SaaS service where your task state lives elsewhere | ✓ A repo-local daemon, file-bus, WebUI, memory files, and optional Telegram interface |

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
| L5 | Local agent runtime | Receive arbitrary instructions, plan, use tools, keep task state | **aiwff-runtime minimal-brain** |
| L6 | Multi-node orchestration | Several machines and agents coordinate as a fleet | Full AIWFF |

aiwff-runtime is the L5 base: a single-machine agent runtime with persistent task state. Full AIWFF is the larger L6 system.

## Architecture

The minimal-brain design has 8 components. Phase 2 implements the practical core: daemon, Telegram polling, Claude CLI worker, file-bus, WebUI, `CLAUDE.md` brain configuration, and lightweight memory injection.

For a compact source-oriented map of the runtime loop, see [`docs/architecture.md`](docs/architecture.md).

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

## Quick Start

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

> **Custom port / Windows note:** the default port is `3100`. To use another port: `PORT=3200 npm start` (bash / macOS / Linux). On **Windows PowerShell** the inline `VAR=value command` form does not work — run `$env:PORT=3200; npm start` instead.

Then verify it:

1. Open `http://127.0.0.1:3100`.
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
5. Send any message to `@userinfobot`.
6. Copy your numeric chat ID.
7. Paste it into `.env` as `ADMIN_TG_CHAT_ID`.

`ADMIN_TG_CHAT_ID` is required when `TG_BOT_TOKEN` is set. If it is left empty, the runtime refuses Telegram polling.

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

## Configuration

Copy `.env.example` to `.env`. The current `.env.example` exposes these fields:

| Variable | Required? | Default / empty value | Used by | Description |
|---|---:|---|---|---|
| `PORT` | No | `3100` | `agent/index.js` | HTTP port for the daemon and WebUI |
| `TG_BOT_TOKEN` | Required for Telegram | empty | `agent/index.js` | Telegram Bot token from `@BotFather`; if empty, WebUI still runs but TG polling does not start |
| `ADMIN_TG_CHAT_ID` | Required when `TG_BOT_TOKEN` is set | empty | `agent/index.js` | Restricts accepted TG messages to one admin chat |
| `CLAUDE_CMD` | No | `claude` | `agent/index.js` | Command used to spawn Claude CLI; on Windows, `claude.cmd` is resolved through `cmd.exe` |
| `MOCK_WORKER` | No | `1` | `agent/index.js` | Public-safe default: use the mock worker instead of Claude CLI |
| `ENABLE_REAL_CLAUDE_WORKER` | Required for real Claude worker | empty | `agent/index.js` | Set to `1` only when you intentionally want Claude CLI execution |
| `CLAUDE_BYPASS_APPROVALS` | Optional unsafe mode | empty | `agent/index.js` | Set to `1` only if you intentionally want `--dangerously-skip-permissions` on `claude --print` |

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
```

`WORK_DIR` appears in the design draft, but it is not present in the current `.env.example` and is not read by the current Phase 2 runtime.

## Browse 578+ Skills

[skill-and-plugins-zh-tw](https://github.com/zaxardery8011-design/skill-and-plugins-zh-tw)

This repo is the engine. That repo is the skill catalogue - combine them for a customizable personal AI assistant powered by 578+ capabilities.

## Vs Full AIWFF

The rule of this repo: remove multi-node complexity, keep the single-machine agent loop understandable.

| Area | Full AIWFF | aiwff-runtime minimal-brain |
|---|---|---|
| Brain configuration | Multi-file governance stack for identity, boundaries, and operating rules | `CLAUDE.md` for identity, boundaries, rules, and output contract |
| Cross-session memory | Structured memory, typed frontmatter, sedimentation, dedupe | Lightweight Markdown memory files injected into the prompt |
| Task governance | Inbox, watching, patrol, backlog SSOT | Minimal design target: simplified inbox and watching surfaces |
| Fleet | Main brain machine + other nodes + cross-machine dispatch | Single-machine only |
| External consultation | Gemini / Codex / other advisory workers | Optional future extension, not required for Phase 2 |
| Self-verification | Multi-agent review and stronger governance checks | Artifact existence check now; fuller self-review is a hardening target |
| Interfaces | TG, LINE, WebUI, and more | TG plus WebUI in Phase 2 |
| Setup difficulty | High, because the governance model is larger | Low, because `.env` and `CLAUDE.md` are the main user-facing controls |

## Honest Limitations

These limitations are intentionally not softened.

| 限制 | 說明 |
|---|---|
| 需要 Claude Max Plan | 真實 Claude worker 若開啟 approval/sandbox bypass，需確認帳號與 CLI 模式支援 |
| 單用戶設計 | 一個 TG Bot 只綁一個管理員 ID，不適合多人共用 |
| 無多節點 | 只跑在單台機器，不支援多節點 fleet 派工 |
| Windows PATH 設定 | Claude CLI 在 Windows 需要確認 PATH 包含 claude.cmd |
| 記憶是文字注入非 RAG | 記憶量大時 context 會撐大；建議定期整理 `memory/facts.md` |
| 不適合長跑任務 | 超過 10 分鐘的任務沒有斷點續傳機制（AIWFF 完整版才有） |

## Roadmap

| Phase | Status | Scope |
|---|---|---|
| Phase 1 | ✅ Done | Mock-first task lifecycle, local file-bus, WebUI, demo verification |
| Phase 2 | PR branch / not public baseline until merged | Claude CLI worker, TG Bot polling, `CLAUDE.md` brain configuration, lightweight memory injection |
| Phase 3 | ⬜ Planned | Memory Layer hardening: better extraction, organization, and long-term context management |

Until this PR is merged, the public `master` baseline remains Phase 1. Phase 2 is the current PR branch scope.

## License

MIT
