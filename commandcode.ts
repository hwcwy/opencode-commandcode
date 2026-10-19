/**
 * Command Code provider plugin for OpenCode V2.
 *
 * Ported from @herouucn/opencode-commandcode (V1 plugin API) to the V2 plugin API.
 *
 * Everything the plugin knows comes from Command Code's own endpoints:
 *  - https://api.commandcode.ai/provider/v1/models decides which models exist, their context
 *    window and which endpoint serves them (the Anthropic Messages route for Claude models,
 *    the OpenAI-compatible route for everything else).
 *  - The official docs pages embed one server-rendered JSON catalog with the capabilities
 *    (text, vision, reasoning), context window, official prices (including long-context
 *    tiers) and the minimum subscription plan each model needs.
 *  - The `plan` answer of the API-key form (or COMMANDCODE_PLAN) filters the picker to the
 *    models the account can use, using that minimum plan.
 *
 * No third-party catalog is consulted. On fetch failure the last good data is reused from
 * plugin storage.
 *
 * Credentials (pick one):
 *  - `COMMANDCODE_API_KEY` on the OpenCode server, e.g.:
 *      opencode service set env COMMANDCODE_API_KEY <key>
 *  - connect in the TUI (`/connect` -> Command Code) or:
 *      opencode auth login commandcode --method key
 *
 * Optional overrides:
 *  - COMMANDCODE_PLAN: `go` | `goat` | `pro` | `max` (or `all` to show everything)
 *  - COMMANDCODE_DOCS_URL: alternate official docs page, or `disabled` for no catalog fetch
 *  - COMMANDCODE_OFFLINE=1: never fetch, use the cached catalog only
 *
 * Command Code's Provider API accepts only text and image content, so this plugin rewrites
 * what it rejects: document attachments (including documents inside tool results) become
 * markdown file references the model can open with its own tools, and mid-conversation
 * system-role messages move into the top-level system prompt.
 */
import { Plugin, Provider, Model } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

const PROVIDER_ID = "commandcode"
const INTEGRATION_ID = "commandcode"
const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1/"
const OFFICIAL_MODELS_URL = "https://api.commandcode.ai/provider/v1/models"
/** The plan pages share one server-rendered catalog; page order is the fallback order. */
const DOCS_MODEL_PAGES = [
  "https://commandcode.ai/docs/plans/go",
  "https://commandcode.ai/docs/plans/goat",
  "https://commandcode.ai/docs/plans/pro",
]
const CACHE_KEY = "catalog"
const CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const MIN_DOCS_MODELS = 20
const ATTACHMENT_DIR = ".opencode/attachments"
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

// Command Code serves OpenAI-style models through its OpenAI-compatible
// /chat/completions route, but Claude models only through the Anthropic
// Messages route (/messages). Register Claude models with the matching runtime.
const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"
const ANTHROPIC_COMPATIBLE = "@opencode/ai/providers/anthropic-compatible"

/** Subscription hierarchy from the official docs: every plan includes the models of the plans below it. */
const PLAN_RANKS: Record<string, number> = { go: 1, goat: 2, pro: 3, max: 4 }
/** Key of the API-key form answer that carries the subscription plan. */
const PLAN_FIELD = "plan"

// --- generated:efforts (scripts/sync-efforts.mjs; do not edit below) ---
// Source: command-code@1.84.0 model catalog d6177babb08d.
// The official CLI has no runtime API for reasoning levels: it ships this
// catalog (id + aliases -> reasoningEfforts). Models absent from it get no
// variants, exactly like the official client.
const EFFORTS_SOURCE = "command-code@1.84.0"
const EFFORTS_BY_MODEL: Record<string, readonly string[]> = {
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-haiku-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-5-20251101": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-20250514": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-5-20250929": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-flash": ["off", "high", "max"],
  "deepseek/deepseek-v4-flash-fast": ["low", "high", "max"],
  "deepseek/deepseek-v4-flash-vision-exp": ["off", "high", "max"],
  "deepseek/deepseek-v4-pro": ["off", "high", "max"],
  "deepseek/deepseek-v4.1-flash": ["off", "low", "high", "max"],
  "deepseek/deepseek-v4.1-flash-fast": ["off", "low", "high", "max"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "google/gemini-3.8-flash": ["low", "medium", "high"],
  "google/gemini-4-argon": ["low", "medium", "high"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "inclusionai/ling-3.1-flash": ["low", "medium", "high"],
  "meta/muse-spark-1.1": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-open": ["low", "medium", "high"],
  "meta/muse-wonder-1.0": ["low", "medium", "high", "xhigh"],
  "minimax/minimax-m3-free": ["low", "medium", "high"],
  "MiniMaxAI/MiniMax-M3": ["low", "medium", "high"],
  "MiniMaxAI/MiniMax-M3-Free": ["low", "medium", "high"],
  "mistral/mistral-large-4": ["low", "medium", "high"],
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  "nvidia/nemotron-3.5-super-vl": ["low", "medium", "high"],
  "Qwen/Qwen3.8-27B": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Flash": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max-0902": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max-Prime": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Omni-Flash": ["low", "medium", "xhigh"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "stealth/cat-jam:free": ["low", "medium", "high", "xhigh", "max"],
  "stealth/glyph-cluster:free": ["low", "medium", "high", "xhigh"],
  "stepfun/Step-5-Preview": ["low", "medium", "high"],
  "tencent/hy4-preview": ["low", "medium", "high"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "xai/grok-4.7": ["low", "medium", "high", "xhigh"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "z-ai/glm-5.3-flashx": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
}
// --- /generated:efforts ---

/**
 * The generated block above is only an offline fallback. At runtime the plugin
 * reads the newest official model catalog from the published CLI package
 * (`command-code`, catalog version included) and caches it for a day.
 */
const CLI_PACKAGE = "command-code"
const CLI_REGISTRY_URL = `https://registry.npmjs.org/${CLI_PACKAGE}`
const EFFORT_CACHE_KEY = "efforts"
const EFFORT_TTL_MS = 24 * 60 * 60 * 1000
const EFFORT_FETCH_TIMEOUT_MS = 30_000
const VALID_EFFORT_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"])

interface EffortCatalog {
  version?: string
  catalogVersion?: string
  fetchedAt?: string
  efforts: Record<string, readonly string[]>
}

/** Minimal tar reader: the CLI tarball only contains regular files. */
function parseTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "")
    if (name.length === 0) {
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

/** Return the balanced `[...]` slice starting at the first `[` at or after `from`. */
function sliceBrackets(source: string, from: number): string {
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

function splitObjects(arrayLiteral: string): string[] {
  const objects: string[] = []
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

function quotedValues(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

/** The CLI ships `catalogVersion:"<sha>"` + `data:[{ id, aliases, reasoningEfforts }]`. */
function extractEffortCatalog(source: string): { catalogVersion: string; efforts: Record<string, string[]> } | null {
  const versionMatch = /catalogVersion:"([0-9a-f]{16,})"/.exec(source)
  if (!versionMatch) return null
  const dataStart = source.indexOf("data:", versionMatch.index)
  if (dataStart < 0) return null

  const efforts: Record<string, string[]> = {}
  for (const entry of splitObjects(sliceBrackets(source, dataStart))) {
    const id = /\bid:"([^"]+)"/.exec(entry)
    const levels = /reasoningEfforts:(\[[^\]]*\])/.exec(entry)
    if (!id || !levels) continue
    const list = quotedValues(levels[1]).filter((level) => VALID_EFFORT_LEVELS.has(level))
    if (list.length === 0) continue
    efforts[id[1]] = list
    const aliases = /aliases:(\[[^\]]*\])/.exec(entry)
    for (const alias of aliases ? quotedValues(aliases[1]) : []) efforts[alias] = list
  }
  return Object.keys(efforts).length > 0 ? { catalogVersion: versionMatch[1], efforts } : null
}

/** Pull the newest catalog from the official npm package (registry -> tarball -> cli.mjs). */
export async function fetchLatestEfforts(): Promise<EffortCatalog | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EFFORT_FETCH_TIMEOUT_MS)
  try {
    const metaRes = await fetch(CLI_REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!metaRes.ok) return null
    const meta = (await metaRes.json()) as any
    const version = meta?.["dist-tags"]?.latest
    const tarball = typeof version === "string" ? meta?.versions?.[version]?.dist?.tarball : undefined
    if (typeof version !== "string" || typeof tarball !== "string") return null

    const res = await fetch(tarball, { signal: controller.signal })
    if (!res.ok) return null
    const files = parseTar(gunzipSync(Buffer.from(await res.arrayBuffer())))
    const entry = [...files.keys()].find((name) => name.endsWith("dist/cli.mjs"))
    if (!entry) return null
    const catalog = extractEffortCatalog(files.get(entry)!.toString("utf8"))
    if (!catalog) return null
    return {
      version,
      catalogVersion: catalog.catalogVersion,
      fetchedAt: new Date().toISOString(),
      efforts: catalog.efforts,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function readEffortCache(value: unknown): EffortCatalog | null {
  if (!value || typeof value !== "object") return null
  const record = value as EffortCatalog
  if (!record.efforts || typeof record.efforts !== "object") return null
  const efforts: Record<string, readonly string[]> = {}
  for (const [id, levels] of Object.entries(record.efforts)) {
    if (Array.isArray(levels) && levels.every((level) => typeof level === "string")) {
      efforts[id] = levels as string[]
    }
  }
  return Object.keys(efforts).length > 0 ? { ...record, efforts } : null
}

/** Normalize a model id for effort lookup: case, separators, Anthropic date suffix. */
function normalizeEffortID(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[._]/g, "-")
    .replace(/-\d{8}$/, "")
}

function buildEffortIndex(table: Record<string, readonly string[]>) {
  const exact = new Map<string, readonly string[]>()
  const short = new Map<string, readonly string[]>()
  for (const [id, levels] of Object.entries(table)) {
    exact.set(normalizeEffortID(id), levels)
    const shortID = normalizeEffortID(id.split("/").pop() ?? id)
    if (!short.has(shortID)) short.set(shortID, levels)
  }
  return { exact, short }
}

let effortIndex = buildEffortIndex(EFFORTS_BY_MODEL)

function setEffortTable(table: Record<string, readonly string[]>) {
  effortIndex = buildEffortIndex(table)
}

/**
 * Mirror the official CLI exactly: only catalog entries carry levels
 * (`getSupportedEfforts` there is `catalog.get(model) ?? null`). Every other
 * model gets no variants, matching OpenCode's handling of non-reasoning models.
 */
export function effortsFor(modelID: string): readonly string[] {
  const shortID = modelID.split("/").pop() ?? modelID
  return (
    effortIndex.exact.get(normalizeEffortID(modelID)) ??
    effortIndex.short.get(normalizeEffortID(shortID)) ??
    []
  )
}

interface OfficialModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  supported_endpoints?: unknown
}

interface DocsTier {
  label?: string
  context?: string
  rates?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

interface DocsModel {
  slug?: string
  id?: string
  name?: string
  blurb?: string
  contextWindow?: number
  reasoning?: boolean
  vision?: boolean
  inputCost?: number
  outputCost?: number
  cacheReadCost?: number
  cacheWriteCost?: number
  minPlanName?: string
  launchedAt?: string
  releaseDate?: string
  caps?: { text?: boolean; vision?: boolean; reasoning?: boolean }
  tiers?: DocsTier[]
}

interface CostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface CatalogModel {
  /** Upstream model id, exactly as the official API reports it. */
  id: string
  name?: string
  /** Endpoints the official list reports for this model (e.g. "/messages"). */
  endpoints: string[]
  vision: boolean
  reasoning: boolean
  context?: number
  cost: CostRates
  /** Official long-context band: rates applied above `size` tokens. */
  longContext?: { size: number; rates: CostRates }
  /** Minimum subscription plan, from the docs catalog. */
  minPlan?: string
  released?: number
}

interface CachedCatalog {
  fetchedAt?: string
  api?: OfficialModel[]
  docs?: DocsModel[]
}

function jsonNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * The docs pages carry the catalog as escaped JSON inside a server-rendered payload like
 * `{\"slug\":\"claude-haiku-5-5\",\"id\":\"claude-haiku-5-5\",...}`. Anchor on each `slug`
 * key, match the surrounding braces and unescape the slice.
 */
export function parseDocsModels(html: string): DocsModel[] {
  const models: DocsModel[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(/\\"slug\\":\\"([^\\"]+)\\"/g)) {
    const index = match.index ?? -1
    if (index < 0) continue
    const start = html.lastIndexOf("{", index)
    if (start < 0) continue
    let depth = 0
    let end = -1
    let escaped = false
    for (let i = start; i < html.length; i++) {
      const ch = html[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === "{") depth += 1
      else if (ch === "}") {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) continue
    let parsed: DocsModel
    try {
      parsed = JSON.parse(JSON.parse(`"${html.slice(start, end + 1)}"`)) as DocsModel
    } catch {
      continue
    }
    const id = typeof parsed?.id === "string" ? parsed.id : typeof parsed?.slug === "string" ? parsed.slug : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push(parsed)
  }
  return models
}

/** Docs ids and API ids differ in punctuation, vendor prefixes and date suffixes. */
export function normalizeModelID(value: string): string {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/-\d{8}$/, "")
    .replace(/[._]/g, "-")
    .replace(/:(free|beta|preview|exp)$/, "")
}

export function shortModelID(value: string): string {
  const text = String(value)
  const slash = text.lastIndexOf("/")
  return normalizeModelID(slash >= 0 ? text.slice(slash + 1) : text)
}

/** Match official-API ids against the docs catalog: exact id first, then the vendor-stripped form. */
export function indexDocsModels(models: DocsModel[]): (apiID: string) => DocsModel | undefined {
  const exact = new Map<string, DocsModel>()
  const short = new Map<string, DocsModel>()
  for (const model of models) {
    for (const key of [model.id, model.slug]) {
      if (typeof key !== "string" || key.length === 0) continue
      const exactKey = normalizeModelID(key)
      if (!exact.has(exactKey)) exact.set(exactKey, model)
      const shortKey = shortModelID(key)
      if (!short.has(shortKey)) short.set(shortKey, model)
    }
  }
  return (apiID) => exact.get(normalizeModelID(apiID)) ?? short.get(shortModelID(apiID))
}

function parseContextSize(label: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*([KMB])?/i.exec(label)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (match[2] ?? "").toUpperCase()
  const scale = unit === "K" ? 1_000 : unit === "M" ? 1_000_000 : unit === "B" ? 1_000_000_000 : 1
  return Math.round(value * scale)
}

/** The docs price the long-context band separately, e.g. `{ context: "> 100K", rates: {...} }`. */
function longContextTier(docs: DocsModel | undefined): { size: number; rates: CostRates } | undefined {
  if (!Array.isArray(docs?.tiers)) return undefined
  for (const tier of docs.tiers) {
    const label = typeof tier?.context === "string" ? tier.context : ""
    if (!label.includes(">")) continue
    const size = parseContextSize(label)
    const rates = tier?.rates
    const input = jsonNumber(rates?.input)
    const output = jsonNumber(rates?.output)
    if (!size || input === undefined || output === undefined) continue
    return {
      size,
      rates: {
        input,
        output,
        cacheRead: jsonNumber(rates?.cacheRead) ?? 0,
        cacheWrite: jsonNumber(rates?.cacheWrite) ?? 0,
      },
    }
  }
  return undefined
}

function parseReleased(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/** Merge the official API list (existence, routing, context) with the docs catalog (caps, prices, plan). */
export function toCatalogModels(
  apiModels: OfficialModel[],
  matchDocs: (id: string) => DocsModel | undefined,
): CatalogModel[] {
  const models: CatalogModel[] = []
  for (const raw of apiModels) {
    if (typeof raw?.id !== "string" || raw.id.length === 0) continue
    const docs = matchDocs(raw.id)
    const endpoints = Array.isArray(raw.supported_endpoints)
      ? (raw.supported_endpoints as unknown[]).filter((value): value is string => typeof value === "string")
      : []
    const name =
      typeof docs?.name === "string" && docs.name.length > 0
        ? docs.name
        : typeof raw.name === "string" && raw.name.length > 0
          ? raw.name
          : raw.id
    models.push({
      id: raw.id,
      name,
      endpoints,
      vision: docs?.vision === true || docs?.caps?.vision === true,
      reasoning: docs?.reasoning === true || docs?.caps?.reasoning === true,
      context: jsonNumber(docs?.contextWindow) ?? jsonNumber(raw.context_length),
      cost: {
        input: jsonNumber(docs?.inputCost) ?? 0,
        output: jsonNumber(docs?.outputCost) ?? 0,
        cacheRead: jsonNumber(docs?.cacheReadCost) ?? 0,
        cacheWrite: jsonNumber(docs?.cacheWriteCost) ?? 0,
      },
      longContext: longContextTier(docs),
      minPlan: typeof docs?.minPlanName === "string" ? docs.minPlanName : undefined,
      released: parseReleased(docs?.launchedAt ?? docs?.releaseDate),
    })
  }
  return models
}

export function normalizePlan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const plan = value.trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(PLAN_RANKS, plan) ? plan : undefined
}

/** A model is visible when its minimum plan is not above the account's plan. */
export function planAllows(minPlanName: unknown, plan: string | undefined): boolean {
  if (!plan) return true
  const minPlan = normalizePlan(minPlanName)
  if (!minPlan) return true
  return PLAN_RANKS[minPlan] <= PLAN_RANKS[plan]
}

/** Same key mapping the V1 plugin used: part after "/", lowercased. */
function toConfigID(fullID: string): string {
  const slash = fullID.indexOf("/")
  const short = slash >= 0 ? fullID.slice(slash + 1) : fullID
  return short.toLowerCase()
}

/** Claude models are served by Command Code through the Anthropic Messages route. */
function isClaudeModel(id: unknown): boolean {
  const value = String(id ?? "").toLowerCase()
  return value.startsWith("claude") || value.startsWith("anthropic/")
}

/** Prefer the route the official list reports; fall back to the model name. */
function usesAnthropicRoute(entry: CatalogModel): boolean {
  if (entry.endpoints && entry.endpoints.length > 0) return entry.endpoints.includes("/messages")
  return isClaudeModel(entry.id)
}

/** Append a suffix to display names shared by several models, like the V1 plugin did. */
function disambiguateNames(entries: CatalogModel[]) {
  const groups = new Map<string, CatalogModel[]>()
  for (const entry of entries) {
    const name = entry.name && entry.name.length > 0 ? entry.name : entry.id
    const group = groups.get(name) ?? []
    group.push(entry)
    groups.set(name, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const entry of group) {
      const suffix = entry.id.split("/").pop() ?? entry.id
      const normalized = suffix.replace(/[-_]/g, " ")
      if (normalized.toLowerCase().includes("free")) {
        entry.name = `${entry.name ?? entry.id} Free`
      } else if (normalized.toLowerCase() !== (entry.name ?? entry.id).toLowerCase()) {
        entry.name = `${entry.name ?? entry.id} (${suffix})`
      }
    }
  }
}

export function toOpenCodeModels(providerID: string, entries: CatalogModel[]) {
  // Colliding config keys keep the last entry, matching the V1 object mapping.
  const byKey = new Map<string, CatalogModel>()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) continue
    byKey.set(toConfigID(entry.id), entry)
  }
  const picked = [...byKey.values()]
  disambiguateNames(picked)

  const models: ReturnType<typeof Model.Info.default>[] = []
  for (const entry of picked) {
    const id = toConfigID(entry.id)
    const base = Model.Info.default(providerID, id)
    const anthropic = usesAnthropicRoute(entry)
    const input = ["text"]
    if (entry.vision) input.push("image")
    const cost: typeof base.cost = [
      {
        input: entry.cost.input,
        output: entry.cost.output,
        cache: { read: entry.cost.cacheRead, write: entry.cost.cacheWrite },
      },
    ]
    if (entry.longContext) {
      cost.push({
        tier: { type: "context", size: entry.longContext.size },
        input: entry.longContext.rates.input,
        output: entry.longContext.rates.output,
        cache: { read: entry.longContext.rates.cacheRead, write: entry.longContext.rates.cacheWrite },
      })
    }
    const levels = effortsFor(entry.id)
    models.push({
      ...base,
      name: entry.name && entry.name.length > 0 ? entry.name : entry.id,
      modelID: entry.id,
      package: anthropic ? ANTHROPIC_COMPATIBLE : OPENAI_COMPATIBLE,
      capabilities: { tools: true, input, output: ["text"] },
      limit: { context: entry.context ?? 200_000, output: 65_536 },
      cost,
      variants: levels.map((level) => ({
        id: level,
        settings: anthropic ? { effort: level } : { reasoningEffort: level },
      })) as typeof base.variants,
      ...(entry.released ? { time: { released: entry.released } } : {}),
    })
  }
  return models
}

/** Command Code's own model list: the authority on which models the Provider API serves. */
async function fetchOfficialModels(): Promise<OfficialModel[] | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(OFFICIAL_MODELS_URL, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { data?: unknown }
      if (!Array.isArray(body?.data)) return null
      const list = (body.data as OfficialModel[]).filter(
        (model) => typeof model?.id === "string" && (model.id as string).length > 0,
      )
      return list.length > 0 ? list : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** The docs catalog: capabilities, prices and the minimum plan for every model, in one page. */
async function fetchDocsModels(override?: string): Promise<DocsModel[] | null> {
  const urls = override && override.length > 0 ? [override] : DOCS_MODEL_PAGES
  for (const url of urls) {
    if (url === "disabled") return null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { accept: "text/html", "user-agent": BROWSER_UA },
        })
        if (!res.ok) continue
        const models = parseDocsModels(await res.text())
        if (models.length >= MIN_DOCS_MODELS) return models
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // try the next page
    }
  }
  return null
}

function readCache(value: unknown): CachedCatalog {
  if (!value || typeof value !== "object") return {}
  const record = value as CachedCatalog
  const api = Array.isArray(record.api)
    ? record.api.filter((model) => typeof model?.id === "string" && (model.id as string).length > 0)
    : []
  const docs = Array.isArray(record.docs)
    ? record.docs.filter((model) => typeof model?.id === "string" || typeof model?.slug === "string")
    : []
  return {
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : undefined,
    api: api.length > 0 ? api : undefined,
    docs: docs.length > 0 ? docs : undefined,
  }
}

type PluginContext = Parameters<ReturnType<typeof Plugin.define>["setup"]>[0]

/** `set` distinguishes an explicit `all` (no filtering) from an unset variable. */
function envPlanSetting(): { set: boolean; plan?: string } {
  const raw = process.env.COMMANDCODE_PLAN?.trim()
  if (!raw) return { set: false }
  const plan = normalizePlan(raw)
  if (plan) return { set: true, plan }
  if (/^(all|any|none|off)$/i.test(raw)) return { set: true, plan: undefined }
  console.warn(`[commandcode] ignoring unknown COMMANDCODE_PLAN "${raw}" (use go, goat, pro, max or all)`)
  return { set: false }
}

/** Read the plan the user picked in the connect form; it is stored on the key credential. */
async function connectionPlan(ctx: PluginContext): Promise<string | undefined> {
  try {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    if (!connection) return undefined
    const credential = await ctx.integration.connection.resolve(connection)
    if (!credential || credential.type !== "key") return undefined
    const answer = credential.configuration?.[PLAN_FIELD]
    return normalizePlan(Array.isArray(answer) ? answer[0] : answer)
  } catch {
    return undefined
  }
}

async function resolvePlan(ctx: PluginContext): Promise<string | undefined> {
  const env = envPlanSetting()
  if (env.set) return env.plan
  return connectionPlan(ctx)
}

export default Plugin.define({
  id: "commandcode",
  async setup(ctx) {
    const offline = process.env.COMMANDCODE_OFFLINE === "1"
    let cache: CachedCatalog = {}
    try {
      cache = readCache(await ctx.storage.get(CACHE_KEY))
    } catch {
      cache = {}
    }

    const fresh = cache.fetchedAt ? Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS : false
    let api: OfficialModel[] | null = null
    let docs: DocsModel[] | null = null
    if (fresh) {
      api = cache.api ?? null
      docs = cache.docs ?? null
    }
    if (!api && !offline) {
      const [apiFresh, docsFresh] = await Promise.all([
        fetchOfficialModels(),
        fetchDocsModels(process.env.COMMANDCODE_DOCS_URL?.trim()),
      ])
      api = apiFresh ?? cache.api ?? null
      docs = docsFresh ?? cache.docs ?? null
      if (apiFresh || docsFresh) {
        try {
          await ctx.storage.set(CACHE_KEY, {
            fetchedAt: new Date().toISOString(),
            api: api ?? undefined,
            docs: docs ?? undefined,
          })
        } catch {
          // caching is best-effort only
        }
      }
    }
    if (!api && offline) {
      api = cache.api ?? null
      docs = cache.docs ?? null
    }

    if (!api || api.length === 0) {
      console.warn("[commandcode] no model list available (official API unreachable and no cache)")
      return
    }

    const catalog = toCatalogModels(api, indexDocsModels(docs ?? []))
    const render = (plan: string | undefined) =>
      toOpenCodeModels(
        PROVIDER_ID,
        plan ? catalog.filter((model) => planAllows(model.minPlan, plan)) : catalog,
      )

    const cachedEfforts = readEffortCache(
      await ctx.storage.get(EFFORT_CACHE_KEY).catch(() => undefined),
    )
    if (cachedEfforts) {
      setEffortTable({ ...EFFORTS_BY_MODEL, ...cachedEfforts.efforts })
      console.log(
        `[commandcode] efforts: cached ${cachedEfforts.version ?? "unknown"} (${Object.keys(cachedEfforts.efforts).length} keys)`,
      )
    }

    let currentPlan = await resolvePlan(ctx)
    let currentModels = render(currentPlan)

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID),
          name: "Command Code",
          activation: "enabled",
          package: OPENAI_COMPATIBLE,
          integrationID: INTEGRATION_ID,
          settings: { baseURL: DEFAULT_BASE_URL },
        },
        models: currentModels,
      })
    })

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: ["COMMANDCODE_API_KEY"] },
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          type: "key",
          label: "API Key",
          form: [
            {
              type: "string",
              key: PLAN_FIELD,
              title: "Subscription plan",
              description: "Models above this plan stay hidden. Pick \"Show all models\" to skip filtering.",
              required: false,
              default: "all",
              custom: false,
              options: [
                { value: "all", label: "Show all models" },
                { value: "go", label: "Go" },
                { value: "goat", label: "GOAT" },
                { value: "pro", label: "Pro" },
                { value: "max", label: "Max" },
              ],
            },
          ],
        },
      })
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = "Command Code"
      })
    })

    // Refresh the official effort catalog in the background (cached for a day).
    // The generated snapshot only covers offline/first run; a newer catalog
    // re-renders the model list without restarting the server.
    const effortsFresh = cachedEfforts?.fetchedAt
      ? Date.now() - Date.parse(cachedEfforts.fetchedAt) < EFFORT_TTL_MS
      : false
    if (!effortsFresh) {
      void (async () => {
        const next = await fetchLatestEfforts()
        if (!next) {
          console.log("[commandcode] efforts: refresh failed; keeping cached/snapshot table")
          return
        }
        setEffortTable({ ...EFFORTS_BY_MODEL, ...next.efforts })
        try {
          await ctx.storage.set(EFFORT_CACHE_KEY, next)
        } catch {
          // caching is best-effort
        }
        currentModels = render(currentPlan)
        await ctx.provider.reload()
        console.log(
          `[commandcode] efforts: refreshed ${next.version} (${Object.keys(next.efforts).length} keys): ${currentModels.filter((model) => model.variants.length > 0).length} models with variants`,
        )
      })()
    }

    // Follow credential changes so a reconnect (or a newly picked plan) updates the picker
    // without restarting the server: transforms replay on reload and read the current list.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as { type?: string }).type ?? ""
          if (type !== "credential.updated" && type !== "credential.switched" && type !== "integration.updated") {
            continue
          }
          const integrationID = (event as { data?: { integrationID?: string } }).data?.integrationID
          if (typeof integrationID === "string" && integrationID !== INTEGRATION_ID) continue
          const next = await resolvePlan(ctx)
          if (next === currentPlan) continue
          currentPlan = next
          currentModels = render(currentPlan)
          await ctx.provider.reload()
          console.log(`[commandcode] plan ${currentPlan ?? "all"}: ${currentModels.length} models`)
        }
      } catch {
        // the event stream ended; the catalog stays as it is
      }
    })()

    // Command Code accepts only text and image content. Rewrite what it rejects:
    // document attachments (and documents inside tool results) become markdown file
    // references the model can open itself, and mid-conversation system-role messages
    // move into the top-level system prompt.
    await ctx.session.hook("context", (event) => {
      if (event.model?.providerID !== PROVIDER_ID) return
      const workspace = ctx.location.directory
      const messages = (event.messages ?? []) as ContentPart[]

      for (const message of messages) {
        if (!Array.isArray(message?.content)) continue
        message.content = (message.content as ContentPart[]).map((part) => {
          if (part?.type === "media") return convertDocumentPart(part, workspace) ?? part
          if (part?.type === "tool-result" && Array.isArray(part.result?.value)) {
            part.result.value = (part.result.value as ContentPart[]).map((item) => {
              if (!item || item.type !== "file") return item
              const mime = String(item.mime ?? "").toLowerCase()
              if (isImageMime(mime)) return item
              const name = sanitizeName(String(item.name ?? "attachment"))
              return fileReference(String(item.uri ?? ""), mime, name, workspace) ?? item
            })
          }
          return part
        })
      }

      // Replayed thinking blocks carry a signature bound to the conversation prefix. Any
      // system-prompt change (OpenCode rewrites it as tools and MCP servers change) makes the
      // upstream reject them with "Invalid signature in thinking block". Command Code's route
      // does not forward the anthropic-beta header that would let the block be dropped
      // server-side, so drop replayed thinking blocks here.
      if (isClaudeModel(event.model?.id)) {
        for (const message of messages) {
          if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
          message.content = (message.content as ContentPart[]).filter((part) => part?.type !== "reasoning")
        }
      }

      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message?.role !== "system") continue
        const content = message.content
        const text = Array.isArray(content)
          ? (content as ContentPart[])
              .filter((part) => part?.type === "text" && typeof part.text === "string")
              .map((part) => String(part.text))
              .join("\n\n")
          : typeof content === "string"
            ? content
            : ""
        if (text.trim().length > 0) event.system.push({ type: "text", text })
        messages.splice(index, 1)
      }
    })

    const hidden = catalog.length - currentModels.length
    console.log(
      `[commandcode] ready: ${currentModels.length} models (plan: ${currentPlan ?? "all"}${
        hidden > 0 ? `, hidden: ${hidden}` : ""
      }, variants: ${currentModels.filter((model) => model.variants.length > 0).length}, docs: ${docs ? docs.length : 0}, cache: ${fresh ? "hit" : "miss"})`,
    )

    return () => controller.abort()
  },
})

type ContentPart = Record<string, any>

/** Keep attachment file names filesystem-safe; stored names are hashed anyway. */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "attachment"
}

function extensionFor(name: string, mime: string): string {
  const fromName = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : ""
  if (/^\.[a-z0-9]{1,5}$/.test(fromName)) return fromName
  if (mime.includes("pdf")) return ".pdf"
  if (mime.includes("text")) return ".txt"
  return ".bin"
}

function fileUrl(absPath: string): string {
  return `file:///${absPath.replace(/\\/g, "/")}`
}

/** Materialize inline bytes inside the workspace so the model can read them back. */
function storeAttachment(base64: string, name: string, mime: string, workspace: string): string {
  const hash = createHash("sha1").update(base64).digest("hex").slice(0, 8)
  const dir = join(workspace, ATTACHMENT_DIR)
  mkdirSync(dir, { recursive: true })
  // Keep the derived attachments out of version control without touching the user's ignores.
  const ignoreFile = join(dir, ".gitignore")
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, "*\n")
  const file = join(dir, `${hash}${extensionFor(name, mime)}`)
  if (!existsSync(file)) writeFileSync(file, Buffer.from(base64, "base64"))
  return fileUrl(file)
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/")
}

/** Markdown reference the model can open itself, or null when it cannot be expressed. */
function fileReference(uri: string, mime: string, name: string, workspace: string): string | null {
  const dataUrl = /^data:([^;]*);base64,(.*)$/is.exec(uri)
  if (dataUrl) return `[${name}](${storeAttachment(dataUrl[2], name, mime || dataUrl[1], workspace)})`
  if (/^https?:\/\//i.test(uri)) return `[${name}](${uri})`
  if (uri.startsWith("file:")) return `[${name}](${fileUrl(decodeURIComponent(uri.replace(/^file:\/\/\/?/i, "")))})`
  if (uri.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(uri)) return `[${name}](${storeAttachment(uri, name, mime, workspace)})`
  return null
}

/** Command Code rejects document parts, so swap them for a file reference. */
function convertDocumentPart(part: ContentPart, workspace: string): ContentPart | null {
  const media = part.media ?? {}
  const source = media.source ?? {}
  const mime = String(media.mediaType ?? source.mediaType ?? "").toLowerCase()
  const kind = String(media.kind ?? "")
  if (kind !== "document" && (mime.length === 0 || isImageMime(mime))) return null
  const name = sanitizeName(String(part.filename ?? "attachment"))
  const uri = typeof source.url === "string" ? source.url : typeof source.data === "string" ? source.data : ""
  const reference = fileReference(uri, mime, name, workspace)
  return reference ? { type: "text", text: reference } : null
}
