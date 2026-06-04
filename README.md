# GRASF

**Graph Retrieval and Awareness Session Framework**

Every new AI coding session starts cold. GRASF fixes that. It attaches a persistent knowledge graph to your project, extracts structured knowledge from Claude Code sessions, and injects the right context back at the start of the next one — automatically, in the background, without changing how you work.

---

## Quickstart

```bash
cd my-project
npx grasf init
```

That's it. Open Claude Code normally. GRASF runs in the background from here.

`grasf init` scans your codebase, builds an initial knowledge graph, installs Claude Code hooks, and writes a `CLAUDE.md` to your repo root. Claude Code reads `CLAUDE.md` automatically at the start of every session.

---

## Recording decisions — the annotation system

**Layer 0 (free, no API key) tracks code structure but not intent.** It knows what functions exist; it doesn't know why you made the choices you made. Annotations are how you bridge that gap.

Type any of these in a Claude Code prompt and GRASF records them immediately, before the AI even sees your message:

| Annotation | What it records |
|---|---|
| `grasf:decision Use RS256 for JWT — needed for gateway verification` | A pinned architectural decision. Never decays. |
| `grasf:goal Refactor the auth module to be stateless` | The intent for this session. Appears in the next session's context. |
| `grasf:note Token TTL is 15 minutes per security policy` | A plain note node in the graph. |
| `grasf:dead-end Redis session store — adds infra dependency, abandoned` | A path you ruled out. Shows in Remnant traces so you don't revisit it. |

Annotations work on all three layers. On Layer 0 they are the only way to capture intent. On Layers 1 and 2, the LLM extracts decisions and goals automatically from conversation — but annotations override and extend that.

---

## The three layers

GRASF auto-detects which layer to use based on what's available. You can force a layer with the `GRASF_LAYER` environment variable.

| Layer | Requires | Cost | What it extracts |
|---|---|---|---|
| **0 — Structural** | Nothing | Free | Code structure: functions, classes, imports, file relationships. Annotations you type explicitly. |
| **1 — API** | `ANTHROPIC_API_KEY` | ~$0.01–0.03/session | Everything in Layer 0, plus: decisions, goals, dead-ends, outcomes — extracted from the conversation transcript. |
| **2 — Local** | [Ollama](https://ollama.com) + a model | Free | Same as Layer 1. Quality depends on the local model. Needs ~4 GB RAM for a 7B model. |

**Layer 0 is honest about what it gives you.** It tracks your codebase and whatever you annotate. It does not read conversations. If you want GRASF to understand *why* you made a change — not just *what* changed — use Layer 1 or Layer 2.

**Detection priority:**
```
GRASF_LAYER env var (override) → ANTHROPIC_API_KEY set → Ollama running → Layer 0
```

### Setting up Layer 1

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Uses `claude-haiku-4-5` — the cheapest, fastest Anthropic model. GRASF sends the session transcript once at session end, not per-message. A typical session costs $0.01–0.03.

### Setting up Layer 2

```bash
# Install Ollama: https://ollama.com
ollama pull mistral
```

GRASF checks `http://localhost:11434` at session end and selects the best available model in this order: `mistral:7b`, `llama3.2:3b`, `llama3:8b`, `phi3:mini`. No API key needed.

---

## How it works

After every Claude Code session ends, the Stop hook fires automatically:

1. Rescans files modified during the session (Tree-sitter AST)
2. If Layer 1 or 2: reads the JSONL session transcript and sends it to the LLM for extraction
3. Merges extracted knowledge into the SQLite graph
4. Runs a decay pass — nodes not recently accessed fade toward archival; decisions and goals never decay below a floor
5. Regenerates `CLAUDE.md` (and `AGENTS.md` if present) from the updated graph
6. Records the session

The next time Claude Code starts, it reads the freshly generated `CLAUDE.md` and already knows what was done, what was decided, and what was ruled out.

**Nothing in this pipeline is visible to you during the session.** The hooks run silently before and after your prompts.

---

## CLI reference

```bash
grasf init                     # Scan repo, build initial graph, install hooks
grasf status                   # Show graph stats and active layer
grasf query <text>             # FTS5 search across the graph
grasf inject                   # Regenerate CLAUDE.md and AGENTS.md from current graph
grasf inject --stdout          # Print context slice to stdout
grasf inject --format claude   # Regenerate only CLAUDE.md
grasf inject --format agents   # Regenerate only AGENTS.md
grasf hooks install            # (Re)install Claude Code hooks
grasf hooks uninstall          # Remove GRASF hooks
grasf session list             # List sessions with goal summaries
grasf session show <id>        # Show full session record
grasf decay run                # Manually trigger a decay pass
grasf gc                       # Archive remnants older than 30 days
grasf config set <key> <val>   # Set a config value
grasf config show              # Show current config
grasf watch                    # Start file-change watcher (daemon, Layer 0)
```

---

## Config reference

GRASF stores per-project config at `.grasf/config.json`. The defaults work for most projects. Change them with `grasf config set <key> <value>`.

| Key | Default | Description |
|---|---|---|
| `extraction_layer` | `"auto"` | Force a layer: `"structural"`, `"api"`, or `"local"`. Default auto-detects. |
| `token_budget` | `2000` | Max tokens for context injection per prompt. |
| `decay_threshold` | `0.15` | Nodes with score below this become remnants. |
| `decision_floor` | `0.3` | Minimum decay score for decision and goal nodes — they never fully fade. |
| `ollama_url` | `"http://localhost:11434"` | Ollama endpoint. Override if running on a different host. |
| `ollama_model_preference` | `["mistral:7b", "llama3.2:3b", "llama3:8b", "phi3:mini"]` | Model priority order. First found in `/api/tags` is used. |
| `anthropic_model` | `"claude-haiku-4-5-20251001"` | Anthropic model for semantic extraction. |
| `skip_dirs` | `["node_modules", ".git", "dist", ...]` | Directories excluded from structural scan. |
| `max_inject_lines` | `150` | Max lines in a generated context file. |

---

## What GRASF writes to your project

```
your-project/
├── CLAUDE.md              ← Auto-generated context file. Read by Claude Code on startup.
├── AGENTS.md              ← Same content, formatted for Codex / other agents.
└── .grasf/
    ├── graph.db           ← SQLite knowledge graph. All data lives here.
    ├── config.json        ← Project config.
    ├── error.log          ← Hook errors (never surfaced to Claude Code — silent).
    └── generated/
        ├── CLAUDE.md      ← Source for the repo-root copy.
        └── AGENTS.md
```

Add `.grasf/graph.db` to `.gitignore` if you do not want to commit the graph. The `CLAUDE.md` at the repo root is safe to commit and useful for team members.

---

## Requirements

- **Node.js** ≥ 20.0.0
- **Claude Code** — hooks require Claude Code to be installed
- **Git** — optional, but structural extraction uses git metadata when available

---

## Debugging

```bash
# See what layer is active and graph stats
grasf status

# Check for hook errors (stop.js always exits 0 — errors go here, not to Claude Code)
cat .grasf/error.log

# Query the graph directly
grasf query "auth token"

# Force context regeneration without a session
grasf inject
```

---

## Contributing

```bash
git clone https://github.com/fatimaazfar/grasf
cd grasf
npm install
node --test test/**/*.test.js        # Unit + mocked integration tests (44 tests, no credentials)
node test/integration-layer0.mjs    # Layer 0 full pipeline — no credentials needed
node test/integration-layer1.mjs    # Layer 1 graceful fallback — uses invalid key, no real key needed
node test/integration-layer2.mjs    # Layer 2 graceful fallback — no Ollama needed
node test/integration.test.js       # Mocked Layer 1 + 2 end-to-end with path normalisation
```

**Before opening a PR:**
- All unit tests must pass: `node --test test/**/*.test.js`
- The mocked integration test must pass: `node test/integration.test.js`
- No new dependencies without discussion — the existing stack (better-sqlite3, tree-sitter, commander, @anthropic-ai/sdk) was chosen deliberately

**Project layout:**

```
src/
├── cli.js                 # Commander CLI — all 13 commands
├── config.js              # Config loading + repo root detection
├── logger.js              # Console wrapper
├── extract/
│   ├── mode.js            # Layer detection (single source of truth)
│   ├── structural.js      # Tree-sitter AST extraction
│   ├── llm.js             # Anthropic + Ollama extraction (same prompt, both paths)
│   ├── ollama.js          # Ollama HTTP client (Node.js fetch, no extra dep)
│   ├── transcript.js      # JSONL transcript parser
│   ├── merge.js           # Merge LLM results into graph
│   └── annotations.js     # grasf:* annotation parser
├── graph/
│   ├── db.js              # SQLite open + schema init (WAL mode, FTS5)
│   ├── nodes.js           # Node CRUD + deterministic IDs
│   ├── edges.js           # Edge CRUD
│   └── decay.js           # Decay scoring + remnant threshold
├── retrieval/
│   ├── rank.js            # Context slice builder (scoped, budget-limited)
│   └── query.js           # FTS5 search
├── adapters/
│   ├── claude-md.js       # CLAUDE.md renderer + writer
│   └── agents-md.js       # AGENTS.md renderer + writer
├── hooks/
│   ├── stop.js            # Stop hook — full extraction pipeline
│   ├── prompt-submit.js   # UserPromptSubmit hook — < 200ms, FTS injection
│   ├── session-start.js   # SessionStart hook — session log
│   └── install.js         # Hook installer (merges into .claude/settings.json)
└── init/
    ├── scanner.js         # Initial codebase scan
    └── git.js             # Git metadata helpers
```

The GRASF_BUILD.md in the repo root is the single source of truth for all design decisions. Read it before making any architectural change.

---

## License

MIT
