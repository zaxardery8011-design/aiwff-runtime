# Security Policy

AIWFF Runtime is local-first. The public-safe default is mock-first unless Telegram or real Claude execution is explicitly enabled.

## Supported Version

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

Open an issue with a clear description, reproduction steps, affected files, and expected behavior. Do not include secrets or private data in reports.

## Local Runtime Boundaries

- The default daemon binds to `127.0.0.1`.
- Generated runtime data is written under `data/`.
- Mock workers only read repo-local task files and write repo-local artifacts.
- Telegram polling requires `TG_BOT_TOKEN` and fails closed without `ADMIN_TG_CHAT_ID`.
- Real Claude CLI workers require explicit `ENABLE_REAL_CLAUDE_WORKER=1` opt-in.
- Approval/sandbox bypass requires explicit `CLAUDE_BYPASS_APPROVALS=1` opt-in and must never be the public default.
