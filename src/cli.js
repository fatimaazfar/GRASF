// spec: src/cli.js — Commander.js command definitions.
// All commands are async; errors are caught and printed without stack traces.

import { Command }          from 'commander'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, basename }   from 'node:path'

import { log }              from './logger.js'
import { loadConfig, saveConfig, inferProjectName, findRepoRoot, DEFAULT_CONFIG } from './config.js'
import { openDb }           from './graph/db.js'
import { runDecayPass }     from './graph/decay.js'
import { detectLayer }      from './extract/mode.js'
import { getGitMetadata }   from './init/git.js'
import { detectMonorepo }   from './init/monorepo.js'
import { scanRepo }         from './init/scanner.js'
import { searchByText }     from './retrieval/query.js'
import { buildContextSlice } from './retrieval/rank.js'
import { renderClaudeMd, writeClaudeMd }  from './adapters/claude-md.js'
import { renderAgentsMd, writeAgentsMd }  from './adapters/agents-md.js'
import { installHooks, uninstallHooks }   from './hooks/install.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireInit() {
  const root = findRepoRoot()
  if (!root) {
    log.error('Not initialized. Run `grasf init` first.')
    process.exit(1)
  }
  return root
}

function timeAgo(dateStr) {
  if (!dateStr) return 'unknown'
  const then     = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z')
  const diffMins = Math.floor((Date.now() - then.getTime()) / 60000)
  if (diffMins < 2)   return 'just now'
  if (diffMins < 60)  return `${diffMins} minutes ago`
  const hrs = Math.floor(diffMins / 60)
  if (hrs < 24)       return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
  const days = Math.floor(hrs / 24)
  if (days === 1)     return 'yesterday'
  if (days < 7)       return `${days} days ago`
  return `${Math.floor(days / 7)} week${Math.floor(days / 7) !== 1 ? 's' : ''} ago`
}

function dbSizeStr(repoRoot) {
  try {
    const bytes = statSync(join(repoRoot, '.grasf', 'graph.db')).size
    if (bytes < 1024)       return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  } catch { return 'unknown' }
}

function layerInitLines(layerInfo) {
  if (layerInfo.layer === 'api') {
    const model = layerInfo.model?.split('-').slice(0, 4).join('-') || layerInfo.model
    return [
      `  Layer: API (${model})`,
      `    → Semantic extraction active. ~$0.01–0.03/session.`,
    ]
  }
  if (layerInfo.layer === 'local') {
    return [
      `  Layer: Local (${layerInfo.model} via Ollama)`,
      `    → Semantic extraction active. Free.`,
    ]
  }
  return [
    `  Layer: Structural (free)`,
    `    → Code structure tracked automatically.`,
    `    → Type grasf:decision <text> in any prompt to record decisions.`,
    `    → Set ANTHROPIC_API_KEY for full semantic extraction.`,
  ]
}

function layerStatusLines(layerInfo) {
  if (layerInfo.layer === 'api') {
    const model = layerInfo.model?.split('-').slice(0, 4).join('-') || layerInfo.model
    return [
      `Extraction layer: API  ✓  (${model})`,
      `  → Semantic extraction active. ~$0.01–0.03/session.`,
    ]
  }
  if (layerInfo.layer === 'local') {
    const modelLabel = layerInfo.model ? `${layerInfo.model} via Ollama` : 'Ollama'
    return [
      `Extraction layer: Local  ✓  (${modelLabel})`,
      `  → Semantic extraction active. Free.`,
    ]
  }
  return [
    `Extraction layer: Structural  (free, code-only)`,
    `  → No LLM configured. Tracking code structure only.`,
    `  → To enable semantic extraction:`,
    `     API:   export ANTHROPIC_API_KEY=sk-...`,
    `     Local: install Ollama + ollama pull mistral`,
  ]
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdInit() {
  const repoRoot = process.cwd()
  const layerInfo    = await detectLayer()
  const gitMeta      = getGitMetadata(repoRoot)
  const monoInfo     = detectMonorepo(repoRoot)
  const projectName  = inferProjectName(repoRoot)

  const config = {
    ...DEFAULT_CONFIG,
    project_name:    projectName,
    monorepo:        monoInfo.isMonorepo,
    scopes:          monoInfo.scopes,
    extraction_layer: 'auto',
    hooks_installed:  false,
    created_at:      new Date().toISOString(),
  }
  saveConfig(repoRoot, config)

  const db    = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const stats = await scanRepo(db, repoRoot, config, config.scopes[0] || 'root', gitMeta.hash || null)

  const slice    = buildContextSlice(db, { scope: config.scopes[0] || 'root', tokenBudget: config.token_budget })
  const claudeMd = renderClaudeMd(slice, projectName, layerInfo, repoRoot)
  writeClaudeMd(claudeMd, repoRoot)
  writeAgentsMd(renderAgentsMd(slice, projectName, layerInfo), repoRoot)

  const hookResult = installHooks(repoRoot)
  config.hooks_installed = hookResult.installed || hookResult.reason === 'already installed'
  saveConfig(repoRoot, config)

  const hooksLabel = hookResult.installed ? 'installed' : hookResult.reason

  log.info(`✓ GRASF initialized — ${projectName}`)
  log.info(`  Graph: ${stats.nodesCreated} nodes built from codebase`)
  log.info(`  Hooks: ${hooksLabel} (Stop, UserPromptSubmit, SessionStart)`)
  for (const line of layerInitLines(layerInfo)) log.info(line)
  log.info('')
  log.info('  Start Claude Code normally. GRASF runs in the background.')
  log.info('  Run `grasf status` at any time to inspect the graph.')
}

async function cmdInject(opts) {
  const repoRoot  = requireInit()
  const config    = loadConfig(repoRoot)
  const db        = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const layerInfo = { layer: config.extraction_layer === 'auto' ? 'structural' : config.extraction_layer, model: null }
  const slice     = buildContextSlice(db, { scope: config.scopes?.[0] || 'root', tokenBudget: config.token_budget })

  if (opts.stdout) {
    log.info(renderClaudeMd(slice, config.project_name, layerInfo, repoRoot))
    return
  }

  const fmt = opts.format || 'all'
  if (fmt !== 'agents') {
    const content = renderClaudeMd(slice, config.project_name, layerInfo, repoRoot)
    writeClaudeMd(content, repoRoot)
    log.info(`✓ CLAUDE.md regenerated`)
  }
  if (fmt !== 'claude') {
    writeAgentsMd(renderAgentsMd(slice, config.project_name, layerInfo), repoRoot)
    log.info(`✓ AGENTS.md regenerated`)
  }
}

async function cmdStatus() {
  const repoRoot  = requireInit()
  const config    = loadConfig(repoRoot)
  const db        = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const layerInfo = await detectLayer()

  const total    = db.prepare('SELECT COUNT(*) as n FROM nodes').get().n
  const active   = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE status='active'").get().n
  const remnants = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE status='remnant'").get().n
  const archived = total - active - remnants
  const decisions = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE type='decision' AND status='active'").get().n
  const lastSess  = db.prepare('SELECT * FROM sessions ORDER BY ended_at DESC LIMIT 1').get()

  const sep = '─────────────────────────────'
  log.info(`GRASF — ${config.project_name || basename(repoRoot)}`)
  log.info(sep)
  log.info(`Graph: ${total} total nodes`)
  if (total > 0) {
    log.info(`  Active:   ${active}  (${((active / total) * 100).toFixed(1)}%)`)
    log.info(`  Remnants: ${remnants} (${((remnants / total) * 100).toFixed(1)}%)`)
    log.info(`  Archived: ${archived} (${((archived / total) * 100).toFixed(1)}%)`)
  }
  log.info('')
  log.info(`Decisions: ${decisions} pinned (never decay)`)
  if (lastSess) {
    log.info(`Last session: ${timeAgo(lastSess.ended_at)}`)
    if (lastSess.goal)      log.info(`  Goal:    ${lastSess.goal}`)
    if (lastSess.outcome)   log.info(`  Outcome: ${lastSess.outcome}`)
    if (lastSess.next_step) log.info(`  Next:    ${lastSess.next_step}`)
  } else {
    log.info('Last session: none recorded')
  }
  log.info('')
  for (const line of layerStatusLines(layerInfo)) log.info(line)
  log.info('')

  let hooked = false
  try {
    const p = join(repoRoot, '.claude', 'settings.json')
    if (existsSync(p)) hooked = JSON.stringify(JSON.parse(readFileSync(p, 'utf8'))).toLowerCase().includes('grasf')
  } catch { /* ignore */ }
  log.info(`Hooks: ${hooked ? '✓ installed' : '✗ not installed'} (Stop, UserPromptSubmit, SessionStart)`)
  log.info(`DB: ${dbSizeStr(repoRoot)}`)
  log.info(sep)
  log.info("Run `grasf inject` to regenerate context files.")
}

function cmdQuery(text) {
  const repoRoot = requireInit()
  const db       = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const results  = searchByText(db, text, { limit: 20 })
  if (results.length === 0) {
    log.info(`No results for "${text}"`)
    return
  }
  log.info(`Results for "${text}":`)
  for (const n of results) {
    const loc     = n.file_path ? ` (${n.file_path})` : ''
    const summary = n.summary ? `: ${n.summary}` : ''
    log.info(`  ${n.name}${loc}${summary}`)
  }
}

function cmdHooksInstall() {
  const repoRoot = requireInit()
  const result   = installHooks(repoRoot)
  if (result.installed) {
    log.info('✓ Hooks installed (Stop, UserPromptSubmit, SessionStart)')
    const config = loadConfig(repoRoot)
    saveConfig(repoRoot, { ...config, hooks_installed: true })
  } else {
    log.info(`Hooks already installed — ${result.reason}`)
  }
}

function cmdHooksUninstall() {
  const repoRoot = requireInit()
  const result   = uninstallHooks(repoRoot)
  if (result.uninstalled) {
    log.info('✓ GRASF hooks removed from .claude/settings.json')
    const config = loadConfig(repoRoot)
    saveConfig(repoRoot, { ...config, hooks_installed: false })
  } else {
    log.info(`Nothing to remove — ${result.reason}`)
  }
}

function cmdSessionList() {
  const repoRoot = requireInit()
  const db       = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const total    = db.prepare('SELECT COUNT(*) as n FROM sessions').get().n
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY ended_at DESC LIMIT 20').all()
  if (sessions.length === 0) {
    log.info('No sessions recorded yet.')
    return
  }
  log.info(`Sessions (${total} total, showing last ${sessions.length}):`)
  sessions.forEach((s, i) => {
    const num = total - i
    log.info(`  #${num} — ${timeAgo(s.ended_at)}  [${s.extraction_layer}]`)
    if (s.goal)      log.info(`     Goal: ${s.goal}`)
    if (s.next_step) log.info(`     Next: ${s.next_step}`)
  })
}

function cmdSessionShow(id) {
  const repoRoot = requireInit()
  const db       = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const s        = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  if (!s) {
    log.error(`Session "${id}" not found.`)
    process.exit(1)
  }
  log.info(`Session: ${s.id}`)
  log.info(`  Started:  ${s.started_at}`)
  log.info(`  Ended:    ${s.ended_at}`)
  log.info(`  Layer:    ${s.extraction_layer}`)
  log.info(`  Scope:    ${s.scope}`)
  if (s.goal)      log.info(`  Goal:     ${s.goal}`)
  if (s.outcome)   log.info(`  Outcome:  ${s.outcome}`)
  if (s.next_step) log.info(`  Next:     ${s.next_step}`)
  if (s.changed_files) {
    try {
      const files = JSON.parse(s.changed_files)
      if (files.length > 0) log.info(`  Files:    ${files.join(', ')}`)
    } catch { /* ignore */ }
  }
}

function cmdDecayRun() {
  const repoRoot = requireInit()
  const db       = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const result   = runDecayPass(db)
  log.info(`✓ Decay pass complete — scored: ${result.scored}, remnants: ${result.archived}`)
}

function cmdGc() {
  const repoRoot = requireInit()
  const db       = openDb(join(repoRoot, '.grasf', 'graph.db'))
  const result   = db.prepare(`
    UPDATE nodes SET status = 'archived', updated_at = datetime('now')
    WHERE status = 'remnant'
      AND datetime(created_at) < datetime('now', '-30 days')
  `).run()
  log.info(`✓ Archived ${result.changes} remnant node(s) older than 30 days`)
}

function cmdConfigShow() {
  const repoRoot = requireInit()
  log.info(JSON.stringify(loadConfig(repoRoot), null, 2))
}

function cmdConfigSet(key, value) {
  const repoRoot = requireInit()
  const config   = loadConfig(repoRoot)
  // Coerce to number/boolean where appropriate
  let parsed = value
  if (value === 'true')  parsed = true
  else if (value === 'false') parsed = false
  else if (!isNaN(Number(value)) && value !== '') parsed = Number(value)
  config[key] = parsed
  saveConfig(repoRoot, config)
  log.info(`✓ ${key} = ${parsed}`)
}

async function cmdWatch() {
  const repoRoot = requireInit()
  const config   = loadConfig(repoRoot)
  const db       = openDb(join(repoRoot, '.grasf', 'graph.db'))

  const { extractStructural } = await import('./extract/structural.js')
  const { default: chokidar } = await import('chokidar')

  log.info(`Watching ${repoRoot} for file changes (Layer 0 — structural only)...`)
  log.info('Press Ctrl+C to stop.')

  chokidar.watch('.', {
    cwd:           repoRoot,
    ignored:       [/node_modules/, /\.grasf/, /\.git/, /dist/, /build/],
    ignoreInitial: true,
    persistent:    true,
  }).on('change', async (relPath) => {
    if (!/\.(js|ts|tsx|jsx|mjs|cjs|py)$/.test(relPath)) return
    const absPath = join(repoRoot, relPath)
    try {
      await extractStructural(db, [absPath], config.scopes?.[0] || 'root', null)
      log.info(`  updated: ${relPath}`)
    } catch (err) {
      log.debug(`watch error on ${relPath}: ${err.message}`)
    }
  })
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command()
program.name('grasf').description('Graph Retrieval and Awareness Session Framework').version('0.1.0')

program.command('init').description('Scan repo, build initial graph, install Claude Code hooks')
  .action(() => cmdInit().catch(e => { log.error(e.message); process.exit(1) }))

program.command('inject').description('Generate CLAUDE.md and AGENTS.md from current graph')
  .option('--stdout', 'Print context slice to stdout instead of writing files')
  .option('--format <fmt>', 'Generate only: claude | agents | all (default: all)')
  .action((opts) => cmdInject(opts).catch(e => { log.error(e.message); process.exit(1) }))

program.command('status').description('Show graph stats and active extraction layer')
  .action(() => cmdStatus().catch(e => { log.error(e.message); process.exit(1) }))

program.command('query <text>').description('FTS5 search, print matching nodes')
  .action((text) => { try { cmdQuery(text) } catch (e) { log.error(e.message); process.exit(1) } })

program.command('watch').description('Start file-change watcher (Layer 0, structural only)')
  .action(() => cmdWatch().catch(e => { log.error(e.message); process.exit(1) }))

const decay = program.command('decay').description('Decay management')
decay.command('run').description('Manually trigger decay scoring pass')
  .action(() => { try { cmdDecayRun() } catch (e) { log.error(e.message); process.exit(1) } })

program.command('gc').description('Archive remnant nodes older than 30 days')
  .action(() => { try { cmdGc() } catch (e) { log.error(e.message); process.exit(1) } })

const hooks = program.command('hooks').description('Manage Claude Code hooks')
hooks.command('install').description('(Re)install GRASF hooks into .claude/settings.json')
  .action(() => { try { cmdHooksInstall() } catch (e) { log.error(e.message); process.exit(1) } })
hooks.command('uninstall').description('Remove GRASF hooks from .claude/settings.json')
  .action(() => { try { cmdHooksUninstall() } catch (e) { log.error(e.message); process.exit(1) } })

const session = program.command('session').description('Session management')
session.command('list').description('List recorded sessions with goal summaries')
  .action(() => { try { cmdSessionList() } catch (e) { log.error(e.message); process.exit(1) } })
session.command('show <id>').description('Show full session record')
  .action((id) => { try { cmdSessionShow(id) } catch (e) { log.error(e.message); process.exit(1) } })

const cfg = program.command('config').description('Configuration management')
cfg.command('show').description('Show current config')
  .action(() => { try { cmdConfigShow() } catch (e) { log.error(e.message); process.exit(1) } })
cfg.command('set <key> <value>').description('Set a config value')
  .action((key, value) => { try { cmdConfigSet(key, value) } catch (e) { log.error(e.message); process.exit(1) } })

export { program }
