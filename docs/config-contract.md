# Config Contract: what the loader reads, what it ignores, and where it degrades silently

This runtime has no config loader. It has an **environment-variable reader** plus a 17-line `.env` parser (`agent/index.js:62-79`, called at `:9`). `config.example.json` is not read by anything.

That asymmetry is the whole reason for this document. A key that the reader ignores does not fail — it *degrades to a default and says nothing*, so a renamed key, a typo'd key, or a key written into the wrong file is indistinguishable from a key that was never set. This file names the ignored keys and the silent-degrade paths so the drift is caught in review instead of in production.

Every row names a line that was read, or an output that was produced. Nothing here is inferred from intent.

## Block 1 — keys the runtime actually reads

| Key | Read at | Declared in `.env.example`? | Effect if absent |
|---|---|---|---|
| `PORT` | `agent/index.js:16` | yes (`:4`) | `3100` |
| `TG_BOT_TOKEN` | `:741`, `:752`, `:1001`, `:1203`, `:1205` | yes (`:7`) | Telegram polling never starts (`:1205`) |
| `ADMIN_TG_CHAT_ID` | `:1002`, `:1203` | yes (`:9`) | with a token set, polling is **refused** with a message on stderr (`:1203-1204`) — the one degrade in this file that does leave a receipt |
| `CLAUDE_CMD` | `:818` | yes (`:12`) | `claude` |
| `MOCK_WORKER` | `:900` | yes (`:13`) | falls through to `ENABLE_REAL_CLAUDE_WORKER` |
| `ENABLE_REAL_CLAUDE_WORKER` | `:900` | yes (`:14`) | mock mode |
| `CLAUDE_BYPASS_APPROVALS` | `:823` | yes (`:16`) | `--dangerously-skip-permissions` is not passed |
| `MAX_TASK_RETRIES` | `:37` | **no** | `2` |
| `RETRY_BACKOFF_MS` | `:38` | **no** | `500` |
| `TG_API_BASE_URL` | `:41` | **no** | `https://api.telegram.org` |
| `TG_REQUEST_TIMEOUT_MS` | `:42` | **no** | `20000` |
| `TG_POLL_BASE_MS` | `:43` | **no** | `2000` |
| `TG_POLL_MAX_BACKOFF_MS` | `:44` | **no** | `60000` |
| `ComSpec` | `:810` | n/a — OS-supplied, not user config | `cmd.exe` |

Six user-settable keys are read but declared nowhere. Declaring them is not required by this document; **knowing that the list of read keys is longer than the list of declared keys** is, because a reader who treats `.env.example` as the contract will conclude those six do not exist.

## Block 2 — keys the loader ignores

### `config.example.json` — every key, ignored

`config.example.json` carries five configuration keys. **The runtime reads none of them.** There is no `readFile`, `require`, or `JSON.parse` of that path anywhere in `agent/index.js` (`grep -n "config" agent/index.js` returns nothing).

| Key in `config.example.json` | Line | Read by the runtime? | The env key that actually decides it |
|---|---|---|---|
| `port` | `:3` | no | `PORT` (`agent/index.js:16`) |
| `data_dir` | `:4` | no | none — `DATA_DIR` is hard-coded (`agent/index.js:10`) |
| `worker.command` | `:6` | no | `CLAUDE_CMD` (`:818`), real-Claude path only |
| `worker.args` | `:7` | no | none — built at `:822-825` |
| `mock_mode` | `:9` | no | `MOCK_WORKER` / `ENABLE_REAL_CLAUDE_WORKER` (`:900`) |

The file's own `_note` (`:2`) says it is roadmap-only. That note is on the *producer* side. This table is the *loader* side, which is where a reader looking for "why did my setting not take effect" arrives.

### `.env` lines the parser drops

`loadDotEnv()` matches `^([A-Za-z_][A-Za-z0-9_]*)=(.*)$` (`agent/index.js:73`) and `continue`s on no match (`:74-76`) — no log, no count, no throw. Measured:

```
.env line "PORT : 3100"    -> matched: false   (dropped)
.env line "2PORT=1"        -> matched: false   (dropped)
.env line "TG_BOT_TOKEN=abc" -> matched: true
```

Precedence is also unstated in `.env.example`: `:74` skips any key for which `process.env[name] != null`, so **a real environment variable always wins over `.env`**, including one set to the empty string.

## Block 3 — the four silent degrades

Each of these turns a wrong input into a working default with no output on any stream. Values below are measured, not reasoned.

**1. `envFlag()` accepts exactly two spellings** (`agent/index.js:24-26`): `'1'` and a case-insensitive `'true'`. Everything else is `false`, and because the miss goes through `String(undefined)`, *unset* and *set to a word this function does not know* produce the identical result:

```
ENABLE_REAL_CLAUDE_WORKER=yes     -> envFlag: false  -> shouldUseMockWorker(): true
ENABLE_REAL_CLAUDE_WORKER="TRUE " -> envFlag: false            (trailing space)
ENABLE_REAL_CLAUDE_WORKER=1       -> envFlag: true   -> shouldUseMockWorker(): false
(unset)                           -> envFlag: false
```

This is the sharpest cost in the file, readable today: an operator who sets `ENABLE_REAL_CLAUDE_WORKER=yes` gets **mock output that looks like real worker output**, because `shouldUseMockWorker()` (`:899-901`) is `envFlag('MOCK_WORKER') || !envFlag('ENABLE_REAL_CLAUDE_WORKER')` — an unrecognised value falls to the `!false` branch and selects mock. Nothing in the log distinguishes that from a deliberate mock run.

**2. `envInt()` cannot distinguish garbage from unset** (`:28-32`). `Number.parseInt` returns `NaN` for both, and both return the fallback:

```
TG_POLL_BASE_MS unset  -> 2000
TG_POLL_BASE_MS=abc    -> 2000
```

A typo in the *key* name lands here too — it reads as unset.

**3. `envInt()` clamps out-of-range values instead of rejecting them** (`:33`):

```
TG_POLL_BASE_MS=999999 -> 60000
```

The operator asked for 999999 and got 60000. No message says so.

**4. The quote strip is unbalanced** (`:77`): `.replace(/^['"]|['"]$/g, '')` removes one leading and one trailing quote character independently, so a malformed value is silently repaired and a legitimate trailing quote is silently lost:

```
'"abc'  -> "abc"
'abc"'  -> "abc"
```

## Rule for any new configuration key

A key added to this runtime ships all four of these in the same change:

1. **Name the reader, at a line.** A key with no reader line is not configuration, it is documentation of an intention — say which.
2. **Add it to `.env.example` and to Block 1 above in the same change.** The gap between "read" and "declared" is the drift this document exists to close.
3. **If the key is read by a helper that swallows bad input (`envFlag`, `envInt`), say what the swallowed cases collapse to.** "Invalid falls back to the default" is the contract; leaving it out means a reader has to run the code to find out, as this document did.
4. **If a new degrade path is added, it emits a receipt or it gets a row in Block 3.** Silence is allowed; *unrecorded* silence is not. A degrade a reader has to infer from source is the defect — that is the same rule the task record follows in [`authority-blocks.md`](authority-blocks.md), applied to configuration.
