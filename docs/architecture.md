# Architecture

aiwff-runtime is a local-first task runtime. It keeps the core loop small: a Node.js daemon accepts work, persists task state to files, starts a worker, records progress, writes artifacts, and exposes the same state through a browser cockpit.

## Components

| Component | Responsibility | Current implementation |
|---|---|---|
| Daemon | Owns the runtime loop, task queue, HTTP API, WebUI, and worker spawning | `agent/index.js` listens on `127.0.0.1:${PORT}` |
| File-bus | Stores durable task state, progress, and outputs as normal files | `data/tasks/*.json`, `data/tasks/*.progress.jsonl`, `data/artifacts/` |
| Worker | Executes a task and writes progress plus a final artifact | Mock worker by default; real Claude worker only when explicitly enabled |
| Verifier | Checks that the demo produced a real result | `scripts/verify-demo.js` checks artifact existence, non-empty content, `completed_at`, and task `status: done` |
| WebUI | Gives the operator a local cockpit for tasks, progress, and artifact paths | Served by the daemon at `http://127.0.0.1:3100` by default |
| Telegram polling | Optional chat input/output surface | Starts only when `TG_BOT_TOKEN` is set and `ADMIN_TG_CHAT_ID` is also present |

## Runtime Shape

```text
        +--------------------+
        | Telegram polling  | optional, admin-gated
        +---------+----------+
          |
          v
        +--------------------+        +--------------------+
        | Node.js daemon    |<------>| Browser WebUI     |
        | agent/index.js    |        | 127.0.0.1 cockpit |
        +---------+----------+        +--------------------+
          |
          v
        +-----------------------------+
        | data/tasks/<id>.json        |
        | data/tasks/<id>.progress... |
        +---------+-------------------+
          | spawn
          v
        +--------------------+
        | Worker process    | mock by default
        | or Claude CLI     | opt-in only
        +---------+----------+
          |
          v
        +--------------------+
        | data/artifacts/   | final result
        +--------------------+
```

## Task Lifecycle

```text
POST /api/tasks or Telegram message
  -> daemon writes data/tasks/<id>.json with status pending
  -> daemon starts the selected worker
  -> worker changes the task to running
  -> worker appends data/tasks/<id>.progress.jsonl
  -> worker writes data/artifacts/<id>.result.*
  -> worker marks data/tasks/<id>.json as done or failed
  -> WebUI and optional Telegram notice show the final state
  -> npm run verify-demo checks the latest mock demo artifact
```

## Worker Modes

The public default is mock-first. `MOCK_WORKER=1` is present in `.env.example`, and the daemon also falls back to the mock worker when `ENABLE_REAL_CLAUDE_WORKER` is not set.

Mock mode starts `examples/mock-worker/worker.js`. It writes progress lines, produces `data/artifacts/<task_id>.result.json`, sets `completed_at`, and marks the task `done`. This is the mode used by `npm run demo` and `npm run verify-demo`.

Real Claude mode is explicit opt-in:

```env
ENABLE_REAL_CLAUDE_WORKER=1
```

When real mode is enabled, the daemon spawns `CLAUDE_CMD` with a prompt built from `CLAUDE.md`, `memory/facts.md`, `memory/preferences.md`, the task details, and the required artifact path. Approval and sandbox bypass is not implicit; it is added only when:

```env
CLAUDE_BYPASS_APPROVALS=1
```

## Mock-first Boundaries

- The installable public path should work without Claude CLI, Telegram, OAuth, webhook setup, Task Scheduler, or public network exposure.
- Real providers are explicit opt-in. Leaving `ENABLE_REAL_CLAUDE_WORKER` empty keeps execution in mock mode.
- Telegram is fail-closed for single-user operation: if `TG_BOT_TOKEN` is set but `ADMIN_TG_CHAT_ID` is missing, polling is refused; when an admin ID is present, messages from other chats are ignored.
- The WebUI binds to `127.0.0.1`, so the cockpit is local by default.

## Verifier Contract

`npm run verify-demo` validates the latest mock demo result. It fails unless:

- `data/artifacts/` exists.
- A `*.result.json` artifact exists and is non-empty.
- The artifact has `completed_at`.
- The matching `data/tasks/<task_id>.json` exists.
- The matching task has `status: done`.
