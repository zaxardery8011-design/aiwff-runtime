# Security Policy

AIWFF Runtime Phase 1 is mock-first and local-only. It does not require external API credentials, OAuth tokens, chat platform tokens, or cloud services.

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
- Phase 1 does not connect to Telegram, LINE, Claude OAuth, Task Scheduler, or external APIs.

