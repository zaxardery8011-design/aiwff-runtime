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

When real mode is enabled, the daemon spawns `CLAUDE_CMD --print` with a prompt built from `CLAUDE.md`, `memory/facts.md`, `memory/preferences.md`, the task details, and the required artifact path. The prompt is written through stdin instead of argv so long prompts do not depend on argv quoting. On Windows, spawn goes through `cmd.exe` so the default `claude` command can resolve `claude.cmd`.

Approval and sandbox bypass is not implicit; `--dangerously-skip-permissions` is added only when both flags are set:

```env
CLAUDE_BYPASS_APPROVALS=1
AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS=1
```

If `CLAUDE_BYPASS_APPROVALS` is set alone, the daemon ignores it and logs a `SECURITY WARNING`. Real Claude workers start in `data/workspaces/<task_id>` instead of the repository root, receive `--add-dir data/artifacts`, and default to `--disallowedTools Bash,PowerShell`. `AIWFF_CLAUDE_ALLOWED_TOOLS` can explicitly pass an allowlist through `--allowedTools`.

## Runtime Guardrails

These are the current enforced boundaries and remaining gaps. Each row reflects the behaviour in `agent/index.js` on the default branch; verify against the code rather than against this table's revision.

| Surface | Current enforcement | Remaining gap / honesty note |
|---|---|---|
| HTTP bind address | The daemon listens on `127.0.0.1:${PORT}`, so the WebUI and API are local by default. | This limits exposure to the local machine; it is not network authentication. |
| Write API: `POST /api/tasks` | Requires the runtime token via `x-aiwff-runtime-token`, `Authorization: Bearer <token>`, or the `aiwff_runtime_token_<PORT>` cookie (`HttpOnly; SameSite=Strict`). The token is `AIWFF_RUNTIME_TOKEN` when set; otherwise a random token is generated in memory at startup. Startup prints a one-time WebUI login link (`/?token=...`) that sets the cookie and redirects to a clean URL. Requests without a valid token are rejected with 401. | The token protects write creation and the task result read (next row) only. The cookie is scoped to host `127.0.0.1`, not the port, so multiple runtimes on one machine share the cookie name. |
| Browser write origin | When an `Origin` or `Referer` header is present, it must be `http://127.0.0.1:<PORT>` or `http://localhost:<PORT>`; cross-origin writes are rejected with 403. | Headerless local writes still rely on the runtime token. |
| Task result read: `GET /api/tasks/:id/result` | Requires the same runtime token as the write API (header, Bearer, or cookie; no Origin check for GET); missing or invalid token → 401. `:id` must be a UUID (else 400) and `data/tasks/<id>.json` must exist (else 404). The server only reads `data/artifacts/<id>.result.md` or `<id>.result.json` from paths it builds itself, returns at most 64KB of content (`truncated: true` when cut; `.result.json` returns its `summary`), and answers 404 `result not ready` until the task is `done` with an artifact. The WebUI chat tab calls it when a tracked task finishes and shows the content as plain text. | This is the only token-protected read; the other read endpoints below are still open. |
| Read API: other `GET /api/*` | The remaining read endpoints are available without token checks, including task, progress, events, inbox, logs, memory, settings, doctor, health, and HUD reads. | This is the widest remaining known gap: local read access is unauthenticated. |
| Real Claude worker cwd | Real Claude workers run from `data/workspaces/<task_id>`, not the repository root. | This reduces accidental repo-root access through cwd, but does not by itself prevent absolute-path access. |
| Artifact writes from Claude | Real Claude workers receive `--add-dir data/artifacts`, preserving the intended artifact output path. | This is a Claude CLI boundary, not an operating-system write-denial boundary. |
| Claude tools | Real Claude workers default to `--disallowedTools Bash,PowerShell`; `AIWFF_CLAUDE_ALLOWED_TOOLS` can explicitly pass `--allowedTools`. | On Windows there is no Landlock, Seatbelt, or equivalent OS sandbox here; tool flags are CLI-level restrictions only. |
| Dangerous Claude bypass | `--dangerously-skip-permissions` requires both `CLAUDE_BYPASS_APPROVALS=1` and `AIWFF_ALLOW_DANGEROUS_CLAUDE_BYPASS=1`; enabled or ignored bypass attempts log a `SECURITY WARNING`. | The bypass remains dangerous when explicitly double opted in. |

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
