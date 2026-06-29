# Agent Instructions

This repository is a mock-first local runtime. Keep all work inside this repository unless the user explicitly asks for a separate path.

Allowed:

- Run `npm install`.
- Run `npm run doctor`, `npm run demo`, `npm run verify-demo`, `npm run test`, and `npm run web`.
- Read files inside this repository.

Forbidden:

- Do not call external APIs.
- Do not read `/home`, user profile directories, system directories, or unrelated project directories.
- Do not write outside this repository.
- Do not install global packages.
- Do not add credentials, tokens, private IPs, or personal paths.

Default validation flow:

```bash
npm run doctor
npm run demo
npm run verify-demo
npm run test
```

