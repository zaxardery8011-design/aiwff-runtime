[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# AIWFF Runtime

AIWFF Runtime is a local-first personal agent runtime that turns LLM CLIs into persistent workers with a file-bus, task queue, and verification loop.

## Quick Start

```bash
npm install
npm run doctor
npm run demo
npm run verify-demo
```

To open the WebUI:

```bash
npm run web
```

Then visit `http://127.0.0.1:3100`.

## Codex Install Prompt

```text
你是我的本機 coding agent。請幫我安裝並驗證 aiwff-runtime。

目標：
- 只跑 mock demo
- 不接 Telegram、LINE、Claude OAuth、Task Scheduler
- 不讀取或上傳我的私人檔案
- 安裝完成後啟動 WebUI

步驟：
1. cd aiwff-runtime
2. 確認 Node.js >= 18
3. npm run doctor
4. npm run demo
5. npm run verify-demo
6. 告訴我結果（task id / artifact path / status）
```

## Core Concepts

Daemon: a small local HTTP service that accepts tasks and owns the runtime loop.

File-bus: a repo-local `data/` directory where tasks, progress logs, and artifacts are written as files.

Worker: a spawned process that reads a task, performs work, reports progress, and writes an artifact.

Verifier: scripts and tests that confirm a task reached `done` and produced a usable artifact.

## Task Record Schema

Every task is stored as `data/tasks/<id>.json` with these fields:

```json
{
  "id": "string — unique task identifier",
  "title": "string — human-readable task name",
  "instruction": "string — what the worker should do",
  "status": "pending | running | done | failed",
  "created_at": "ISO 8601 timestamp",
  "updated_at": "ISO 8601 timestamp",
  "artifact_path": "string — path to the result file (set when done)"
}
```

> **Note on status terminology**: the worker process writes `running` internally; the WebUI's `normalizeStatus()` maps `running` → `doing` for display. In API responses and on disk the value is `running`.

Progress is streamed line-by-line to `data/tasks/<id>.progress.jsonl`. Artifacts land in `data/artifacts/<id>.result.json`.

## Architecture

```text
Browser or CLI
     |
     v
HTTP daemon (:3100)
     |
     v
data/tasks/<id>.json  --->  mock worker process
     |                              |
     v                              v
data/tasks/<id>.progress.jsonl   data/artifacts/<id>.result.json
     |
     v
verifier / smoke test
```

## Configuration

The runtime reads one environment variable:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | HTTP port for the daemon |

Copy `.env.example` to `.env` and edit as needed. `npm install` is a no-op (zero external dependencies) — you can skip it.

> **Note on `config.example.json`**: this file is a roadmap preview of planned options (`data_dir`, `worker.command`, `mock_mode`). The current runtime does **not** read it — only `process.env.PORT` is consumed. Future phases will wire these up.

> **Note on task status**: the worker writes `running` internally; the WebUI maps `running` → `doing` for display. On fast machines the mock worker completes in ~3 seconds, so polling may jump directly from `pending` to `done` without catching `running` mid-flight — this is expected behaviour, not a bug.

## Roadmap

- Phase 1 mock-first: complete task lifecycle without external services. ✓
- Phase 2 Claude/Ollama adapter: connect real local or CLI-backed workers.
- Phase 3 Telegram/LINE: add optional chat surfaces after the local runtime is verifiable.

## License

MIT

