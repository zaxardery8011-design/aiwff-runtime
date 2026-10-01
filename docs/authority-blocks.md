# Authority Blocks: who supplies each field, which id is stable

An **authority block** is a record that outlives the process that wrote it and is read back by someone who did not write it — here, `data/tasks/<id>.json` and the artifact it points at. Two questions have to be answered in writing, or the shape drifts every time a new writer appears:

1. **Who supplies each field?** Producer-written, or derived by a reader?
2. **Which id is guaranteed stable** across every later rewrite of the record?

This document answers both for the blocks this runtime actually produces today. Every row names a line that was read; nothing here is inferred from intent.

## Block 1 — the task record `data/tasks/<id>.json`

| Field | Supplied by | Stable across rewrites? |
|---|---|---|
| `id` | `createTaskObject()`, `crypto.randomUUID()` (`agent/index.js:915`) — once, at creation | **Yes.** This is the one stable id. |
| `title`, `instruction` | the caller, at creation (`agent/index.js:911-921`) | Yes — no writer rewrites them |
| `status` | **two producers, selected by worker mode** — see below | No |
| `created_at` | creation timestamp (`agent/index.js:912`, `:919`) | Yes |
| `updated_at` | rewritten on *every* status write (`agent/index.js:783`; mock worker `examples/mock-worker/worker.js:42`) | **No** |
| `timeout_sec` | the caller; present only when `normalizeOptionalTimeoutSec()` returns non-null (`agent/index.js:913`, `:922-924`) | Yes, but **optional** — absent is the normal case |
| `artifact_path` | **two producers, selected by worker mode** — see below | No |
| `retry_count`, `last_error` | the daemon, real-Claude path only (`agent/index.js:884`, `:893`) | No |
| `error` | the daemon on `failed` (`agent/index.js:891-894`); the mock worker on its own failure path (`examples/mock-worker/worker.js:90`) | No |
| `blocked_reason` | the daemon only, on timeout (`agent/index.js:716`) | No |

### Why `id` is the stable one

`id` is also the filename — `taskPath(task.id)` resolves the record, so rewriting `id` would orphan it. Both writers preserve it structurally rather than by intent: `updateTaskStatus()` (`agent/index.js:777-790`) and the mock worker's own copy of it (`examples/mock-worker/worker.js:37-46`) spread `...task` and then set only `status`, `updated_at`, and the caller's `extra`. Neither ever assigns `id`.

`updated_at` is the trap. It moves on every write, so it is a display value only — a reader must not build an identity, a dedup key, or a change-detection key on it. There is no `snapshot_id` or revision counter in this record: **`id` plus `updated_at` does not identify a version**, it identifies a task plus the wall clock of its last write.

## The convention this repo had not written down

`status` and `artifact_path` have a **different producer in each worker mode**, and the artifact they name is in a different format:

| | mock mode (the default) | real-Claude mode (`ENABLE_REAL_CLAUDE_WORKER=1`) |
|---|---|---|
| Producer of `status: done` | **the worker.** `examples/mock-worker/worker.js:79-81` writes the task record itself; the daemon only reads back whatever the worker left (`agent/index.js:664-671`) | **the daemon.** `updateTaskStatus(currentTask, 'done', …)` (`agent/index.js:873`); the worker never touches the task record |
| Producer of `artifact_path` | the worker, `path.relative(ROOT_DIR, artifactPath(id))` (`examples/mock-worker/worker.js:80`) | the daemon, `artifactResultRef(id)` (`agent/index.js:681-683`, `:873`) — never from worker-supplied text |
| File it names | `data/artifacts/<id>.result.json` (`examples/mock-worker/worker.js:25-27`) | `data/artifacts/<id>.result.md` (`agent/index.js:677-679`) |
| Artifact format | JSON object with `task_id` / `title` / `summary` / `completed_at` (`examples/mock-worker/worker.js:71-77`) | prose, ending in a `DONE: …` line — that is what the prompt asks for (`agent/index.js:772-773`; repo `CLAUDE.md`) |

**The cost of leaving that unstated, readable today.** `taskSummary()` resolves `artifact_path` and then JSON-parses the file it names (`agent/index.js:274-276`). That matches the mock artifact exactly. In real-Claude mode the named file is `.result.md` holding prose, so unless a worker happens to write JSON into the `.md`, `readJsonFile` throws, the `catch` at `:277-279` swallows it, and the summary degrades to `''` with no error anywhere. Neither writer is wrong on its own; the gap is that no document said which side supplies the field, or in which format.

The same absence shows up on the reader side. `taskSummary()` tries four shapes in order — `task.result.summary`, `task.result_summary`, `task.summary`, then the artifact's `summary` (`agent/index.js:253-280`). **No writer in this repo produces the first three.** They are reader-side guesses at shapes that were never declared, which is what a consumer is forced into when the authority block has no written contract.

## Rule for any new authority block

Any record added to this runtime that a later reader has to resolve ships this table in the same change:

1. **Name the producer of every field, at a line.** If a field has more than one producer, list each one *and the condition that selects it* — a field with two producers and one row is the drift.
2. **Name exactly one stable id, and say what makes it stable.** Here it is `id`, and what makes it stable is that it is the filename.
3. **Mark every field rewritten on each write as unstable**, so no reader builds an identity or a dedup key on it.
4. **If two producers write the same field in different formats, say so in the same row.** A reader that parses that field then branches on the producer instead of guessing.
5. Adding a producer to an existing block updates this document in the same change. A row that no longer names a real line is a defect in this document, not a detail.
