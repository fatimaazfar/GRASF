// spec: src/extract/structural.js — Layer 0: re-scan changed files via Tree-sitter.
//
// Creates/updates nodes for: functions, classes, exported identifiers, import sources.
// Creates edges: depends_on between files based on relative imports.
// Sets extraction_layer = 'structural' on all created nodes.
// Never touches nodes of type decision, goal, dead_end.
// On parse failure: skip file, log, continue (spec error rule 5).
//
// tree-sitter packages are CommonJS — loaded via createRequire.

import { readFileSync } from 'node:fs'
import { extname, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { upsertNode } from '../graph/nodes.js'
import { upsertEdge } from '../graph/edges.js'

const require = createRequire(import.meta.url)

// Returns a configured Parser for the given extension, or null if unsupported.
function getParser(ext) {
  try {
    const Parser = require('tree-sitter')
    const parser = new Parser()
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      parser.setLanguage(require('tree-sitter-javascript'))
    } else if (ext === '.ts') {
      parser.setLanguage(require('tree-sitter-typescript').typescript)
    } else if (ext === '.tsx') {
      parser.setLanguage(require('tree-sitter-typescript').tsx)
    } else if (ext === '.py') {
      parser.setLanguage(require('tree-sitter-python'))
    } else {
      return null
    }
    return parser
  } catch {
    return null
  }
}

// BFS descendant search — avoids stack overflow on deeply nested ASTs.
function findDescendants(rootNode, targetType) {
  const results = []
  const queue = [rootNode]
  while (queue.length) {
    const node = queue.shift()
    if (node.type === targetType) results.push(node)
    for (const child of node.children) queue.push(child)
  }
  return results
}

function extractEntityNames(root, ext) {
  const names = []
  const functionTypes = ext === '.py'
    ? ['function_definition']
    : ['function_declaration', 'method_definition']
  const classTypes = ext === '.py'
    ? ['class_definition']
    : ['class_declaration']

  for (const t of [...functionTypes, ...classTypes]) {
    for (const node of findDescendants(root, t)) {
      const nameNode = node.childForFieldName('name')
      if (nameNode?.text) names.push({ name: nameNode.text, nodeType: classTypes.includes(t) ? 'module' : 'function' })
    }
  }
  return names
}

function extractImportSources(root, ext) {
  const sources = []
  const importTypes = ext === '.py'
    ? ['import_statement', 'import_from_statement']
    : ['import_statement', 'import_declaration']

  for (const t of importTypes) {
    for (const node of findDescendants(root, t)) {
      for (const child of node.children) {
        if (child.type === 'string') {
          sources.push(child.text.replace(/^['"`]|['"`]$/g, ''))
        }
        if (child.type === 'dotted_name' || child.type === 'relative_import') {
          sources.push(child.text)
        }
      }
    }
  }
  return sources
}

function scanFile(db, filePath, scope, gitHash) {
  const ext = extname(filePath).toLowerCase()
  const parser = getParser(ext)
  if (!parser) return

  let source
  try {
    source = readFileSync(filePath, 'utf8')
  } catch {
    return
  }

  let tree
  try {
    tree = parser.parse(source)
  } catch (err) {
    console.warn(`[GRASF] Tree-sitter parse failed for ${filePath}: ${err.message}`)
    return
  }

  const root = tree.rootNode

  // File module node — represents the file itself.
  const fileModuleId = upsertNode(db, {
    type: 'module',
    name: filePath,
    file_path: filePath,
    scope,
    extraction_layer: 'structural',
    git_hash: gitHash || null
  })

  // Functions and classes within the file.
  for (const { name, nodeType } of extractEntityNames(root, ext)) {
    upsertNode(db, {
      type: nodeType,
      name,
      file_path: filePath,
      scope,
      extraction_layer: 'structural',
      git_hash: gitHash || null
    })
  }

  // Relative imports → depends_on edges between file modules.
  for (const src of extractImportSources(root, ext)) {
    if (!src.startsWith('.')) continue
    const resolvedBase = resolve(dirname(filePath), src)
    const candidates = [resolvedBase, `${resolvedBase}.js`, `${resolvedBase}.ts`,
                        `${resolvedBase}/index.js`, `${resolvedBase}/index.ts`]
    let targetPath = resolvedBase
    for (const c of candidates) {
      try { readFileSync(c); targetPath = c; break } catch { /* try next */ }
    }
    const targetId = upsertNode(db, {
      type: 'module',
      name: targetPath,
      file_path: targetPath,
      scope,
      extraction_layer: 'structural'
    })
    upsertEdge(db, { from_id: fileModuleId, to_id: targetId, rel: 'depends_on' })
  }
}

export async function extractStructural(db, changedFiles, scope = 'root', gitHash = null) {
  for (const filePath of changedFiles) {
    try {
      scanFile(db, filePath, scope, gitHash)
    } catch (err) {
      console.warn(`[GRASF] Structural extraction error for ${filePath}: ${err.message}`)
    }
  }
}
