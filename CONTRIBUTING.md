# Contributing to GRASF

## Before you write any code — read the spec

`GRASF_BUILD.md` is the single source of truth for every design decision in this project. Before touching any file, read the relevant section. If your change conflicts with the spec, the spec wins. If the spec is wrong, open a discussion before writing code.

This rule exists because GRASF's components are tightly coupled — the schema, the hook sequence, the layer detection logic, the CLAUDE.md template, and the decay scoring all depend on each other. Changes that seem isolated often aren't.

---

## Running the tests

```bash
# Unit tests (44 tests, < 10 seconds)
node --test test/**/*.test.js

# Layer 0 integration test — no credentials needed
node test/integration-layer0.mjs

# Layer 1 and 2 mocked integration test — no credentials needed
# Uses a local HTTP mock server to verify the full stop.js pipeline
node test/integration.test.js

# Layer 1 integration test — tests graceful fallback with intentionally invalid API key
node test/integration-layer1.mjs

# Layer 2 integration test — tests graceful fallback when Ollama is not running
node test/integration-layer2.mjs
```

A PR must pass all unit tests and `test/integration.test.js`. The other integration tests are environment-dependent (Layer 1 requires a real key; Layer 2 requires Ollama) but should be run if the change touches extraction code.

---

## No new dependencies

The current dependency set was chosen deliberately:

| Package | Why |
|---|---|
| `better-sqlite3` | Synchronous SQLite — no async complexity, fast, embeds the DB in the project |
| `tree-sitter` + grammars | Production-quality AST parsing for JS/TS/Python without writing parsers |
| `commander` | Standard Node CLI framework |
| `@anthropic-ai/sdk` | Official SDK — avoids maintaining HTTP client details for the API layer |
| `chokidar` | Cross-platform file watching |

Ollama uses Node.js built-in `fetch` — no HTTP library needed.

If you think a new dependency is necessary, open an issue first. The bar is: the alternative is to write significant non-trivial code that this dependency already handles well.

---

## Build order and where to start

GRASF was built in this order. If you're onboarding or adding a feature, this tells you what depends on what:

1. **Schema** (`schema.sql`) — The SQLite schema. Everything else builds on top of it.
2. **Graph layer** (`src/graph/`) — Node/edge CRUD, decay scoring, FTS5.
3. **Extraction** (`src/extract/`) — Structural (tree-sitter), semantic (LLM), transcript parsing, mode detection.
4. **Retrieval** (`src/retrieval/`) — Context slice builder, FTS5 query.
5. **Adapters** (`src/adapters/`) — CLAUDE.md and AGENTS.md renderers.
6. **Hooks** (`src/hooks/`) — `stop.js`, `prompt-submit.js`, `session-start.js`, `install.js`.
7. **CLI** (`src/cli.js`, `bin/grasf.js`) — All 13 commands.
8. **Integration tests** (`test/integration-*.mjs`, `test/integration.test.js`).

A change to the schema almost certainly requires changes to the graph layer, decay scoring, and possibly the context slice builder and adapters. A change to the CLAUDE.md template requires updating the adapter tests. The build order makes the dependency direction explicit.

---

## What a good PR looks like

- Targets one thing. A PR that fixes a bug in decay scoring should not also refactor the CLI.
- Comes with a test. If you're adding behaviour, add a test that would have caught the absence of that behaviour.
- Updates the spec comment in the changed file. Every source file has a `// spec:` comment at the top describing its contract. If you change the contract, update the comment.
- Does not break `npm pack --dry-run`. The published package should only contain `bin/`, `src/`, `schema.sql`, `README.md`, and `LICENSE`. Check with `npm pack --dry-run` before submitting.
