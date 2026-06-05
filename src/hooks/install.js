// spec: src/hooks/install.js — Write GRAASF hooks to .claude/settings.json
// installHooks: merge with existing hooks; skip if "graasf" already present (string match)
// uninstallHooks: remove only graasf hook entries, leave all others intact

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function settingsPath(projectRoot) {
  return join(projectRoot, '.claude', 'settings.json')
}

function loadSettings(path) {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

export function installHooks(projectRoot) {
  const path     = settingsPath(projectRoot)
  const settings = loadSettings(path)

  if (JSON.stringify(settings).toLowerCase().includes('graasf')) {
    return { installed: false, reason: 'already installed' }
  }

  const stopCmd   = `node "${join(__dirname, 'stop.js')}"`
  const submitCmd = `node "${join(__dirname, 'prompt-submit.js')}"`
  const startCmd  = `node "${join(__dirname, 'session-start.js')}"`

  const additions = {
    Stop:             [{ hooks: [{ type: 'command', command: stopCmd   }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: submitCmd }] }],
    SessionStart:     [{ hooks: [{ type: 'command', command: startCmd  }] }],
  }

  settings.hooks = settings.hooks ? { ...settings.hooks, ...additions } : additions

  mkdirSync(join(projectRoot, '.claude'), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
  return { installed: true }
}

export function uninstallHooks(projectRoot) {
  const path = settingsPath(projectRoot)
  if (!existsSync(path)) return { uninstalled: false, reason: 'no settings.json' }

  const settings = loadSettings(path)
  if (!settings.hooks) return { uninstalled: false, reason: 'no hooks found' }

  for (const event of ['Stop', 'UserPromptSubmit', 'SessionStart']) {
    if (!settings.hooks[event]) continue
    settings.hooks[event] = settings.hooks[event]
      .map(group => ({ ...group, hooks: (group.hooks || []).filter(h => !h.command?.toLowerCase().includes('graasf')) }))
      .filter(group => group.hooks.length > 0)
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
  return { uninstalled: true }
}
