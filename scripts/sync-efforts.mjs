#!/usr/bin/env node
/**
 * Regenerate the built-in reasoning-effort table inside commandcode.ts.
 *
 * Command Code's official CLI (`command-code`) has no runtime API for reasoning
 * levels. It ships a versioned model catalog (`xn = { catalogVersion, data: [...] }`)
 * whose entries carry `reasoningEfforts`. This script extracts the newest published
 * catalog so the plugin stays in sync with the official client.
 *
 * Usage:
 *   node scripts/sync-efforts.mjs          # rewrite the generated block
 *   node scripts/sync-efforts.mjs --check  # exit 1 when the block is stale
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const TARGET = join(ROOT, "commandcode.ts")
const PACKAGE = "command-code"
const START = "// --- generated:efforts"
const END = "// --- /generated:efforts ---"
const VALID_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"])

function parseTar(buffer) {
  const files = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "")
    if (!name) {
      offset += 512
      continue
    }
    const size = Number.parseInt(header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim() || "0", 8)
    offset += 512
    files.set(name, buffer.subarray(offset, offset + size))
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

async function loadCli() {
  const meta = await (await fetch(`https://registry.npmjs.org/${PACKAGE}`)).json()
  const version = meta["dist-tags"].latest
  const tarball = meta.versions[version].dist.tarball
  const buffer = Buffer.from(await (await fetch(tarball)).arrayBuffer())
  const files = parseTar(gunzipSync(buffer))
  const entry = [...files.keys()].find((name) => name.endsWith("dist/cli.mjs"))
  if (!entry) throw new Error("dist/cli.mjs not found in the official CLI package")
  return { version, source: files.get(entry).toString("utf8") }
}

/** Return the balanced `[...]` slice starting at the first `[` at or after `from`. */
function sliceBrackets(source, from) {
  const start = source.indexOf("[", from)
  if (start < 0) throw new Error("array start not found")
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "[") depth++
    else if (char === "]") {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error("unbalanced array")
}

/** Split a JS array literal into its top-level object literals. */
function splitObjects(arrayLiteral) {
  const objects = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < arrayLiteral.length; index++) {
    const char = arrayLiteral[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") {
      if (depth === 0) start = index
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0 && start >= 0) {
        objects.push(arrayLiteral.slice(start, index + 1))
        start = -1
      }
    }
  }
  return objects
}

function quotedValues(source) {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function extractCatalog(source) {
  // The catalog is a hash-versioned object; find the hash-bearing occurrence (an
  // earlier `catalogVersion:` property access may exist in unrelated code).
  const versionMatch = /catalogVersion:"([0-9a-f]{16,})"/.exec(source)
  if (!versionMatch) throw new Error("catalogVersion not found")
  const catalogVersion = versionMatch[1]

  const dataStart = source.indexOf("data:", versionMatch.index)
  if (dataStart < 0) throw new Error("model catalog data not found")
  const entries = splitObjects(sliceBrackets(source, dataStart))
  const efforts = new Map()
  for (const entry of entries) {
    const id = /\bid:"([^"]+)"/.exec(entry)
    const levels = /reasoningEfforts:(\[[^\]]*\])/.exec(entry)
    if (!id || !levels) continue
    const list = quotedValues(levels[1]).filter((level) => VALID_LEVELS.has(level))
    if (list.length === 0) continue
    efforts.set(id[1], list)
    const aliases = /aliases:(\[[^\]]*\])/.exec(entry)
    for (const alias of aliases ? quotedValues(aliases[1]) : []) efforts.set(alias, list)
  }
  if (efforts.size === 0) throw new Error("no reasoningEfforts found in the model catalog")
  return { catalogVersion, efforts }
}

function render(version, catalogVersion, efforts) {
  const entries = [...efforts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, levels]) => `  ${JSON.stringify(id)}: [${levels.map((level) => JSON.stringify(level)).join(", ")}],`)
    .join("\n")
  return [
    `${START} (scripts/sync-efforts.mjs; do not edit below) ---`,
    `// Source: ${PACKAGE}@${version} model catalog ${catalogVersion.slice(0, 12)}.`,
    `// The official CLI has no runtime API for reasoning levels: it ships this`,
    `// catalog (id + aliases -> reasoningEfforts). Models absent from it get no`,
    `// variants, exactly like the official client.`,
    `const EFFORTS_SOURCE = ${JSON.stringify(`${PACKAGE}@${version}`)}`,
    `const EFFORTS_BY_MODEL: Record<string, readonly string[]> = {`,
    entries,
    `}`,
    `// --- /generated:efforts ---`,
  ].join("\n")
}

const { version, source } = await loadCli()
const { catalogVersion, efforts } = extractCatalog(source)
const block = render(version, catalogVersion, efforts)
const file = readFileSync(TARGET, "utf8")
const start = file.indexOf(START)
const end = file.indexOf(END)

if (start < 0 || end < 0) {
  console.error(`Markers "${START}" / "${END}" are missing from commandcode.ts`)
  process.exit(1)
}

const next = file.slice(0, start) + block + file.slice(end + END.length)
if (process.argv.includes("--check")) {
  if (next !== file) {
    console.error(`commandcode.ts is stale; run node scripts/sync-efforts.mjs (official CLI ${version})`)
    process.exit(1)
  }
  console.log(`efforts table is up to date (${PACKAGE}@${version}, ${efforts.size} keys)`)
} else {
  writeFileSync(TARGET, next)
  console.log(`wrote ${efforts.size} keys from ${PACKAGE}@${version} catalog ${catalogVersion.slice(0, 12)}`)
}
