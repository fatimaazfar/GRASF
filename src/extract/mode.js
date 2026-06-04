// spec: src/extract/mode.js — Single source of truth for active extraction layer.
//
// IMPORTANT: detectLayer() must only be called from stop.js.
// The Ollama check carries a 2-second timeout — calling it from prompt-submit.js
// would add latency before every user message, breaking the < 200ms requirement.
//
// Layer priority (spec):
//   GRASF_LAYER env override → use that layer
//   ANTHROPIC_API_KEY set    → 'api'
//   Ollama responds          → 'local' (best available model)
//   default                  → 'structural'
//
// Returns one of:
//   { layer: 'api',        model: 'claude-haiku-4-5-20251001', ollamaUrl: null }
//   { layer: 'local',      model: 'mistral:7b',                ollamaUrl: 'http://localhost:11434' }
//   { layer: 'structural', model: null,                        ollamaUrl: null }

import { checkOllama } from './ollama.js'

const API_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
const MODEL_PREFERENCES = ['mistral:7b', 'llama3.2:3b', 'llama3:8b', 'phi3:mini']

function pickModel(models) {
  for (const preferred of MODEL_PREFERENCES) {
    if (models.includes(preferred)) return preferred
  }
  return models[0] || null
}

async function resolveLocal(ollamaUrl) {
  const { running, models } = await checkOllama(ollamaUrl)
  return { layer: 'local', model: running ? pickModel(models) : null, ollamaUrl }
}

export async function detectLayer() {
  const override = process.env.GRASF_LAYER
  const ollamaUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL

  if (override === 'structural') return { layer: 'structural', model: null, ollamaUrl: null }
  if (override === 'api')        return { layer: 'api', model: API_MODEL, ollamaUrl: null }
  if (override === 'local')      return resolveLocal(ollamaUrl)

  if (process.env.ANTHROPIC_API_KEY) return { layer: 'api', model: API_MODEL, ollamaUrl: null }

  const { running, models } = await checkOllama(ollamaUrl)
  if (running && models.length > 0) {
    return { layer: 'local', model: pickModel(models), ollamaUrl }
  }

  return { layer: 'structural', model: null, ollamaUrl: null }
}
