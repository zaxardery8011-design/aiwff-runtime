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

## Roadmap

- Phase 1 mock-first: complete task lifecycle without external services. ✓
- Phase 2 Claude/Ollama adapter: connect real local or CLI-backed workers.
- Phase 3 Telegram/LINE: add optional chat surfaces after the local runtime is verifiable.

## License

MIT

