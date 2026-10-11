/**
 * Command Code provider plugin for OpenCode V2.
 *
 * Ported from @herouucn/opencode-commandcode (V1 plugin API) to the V2 plugin API.
 * At startup it fetches the model catalog (models.json) and registers:
 *  - the `commandcode` provider (OpenAI-compatible runtime, baseURL api.commandcode.ai)
 *  - the model list with limits, costs, capabilities and reasoning-effort variants
 *  - the `commandcode` integration with API-key and env-var credential methods
 *
 * Credentials (pick one):
 *  - `COMMANDCODE_API_KEY` on the OpenCode server, e.g.:
 *      opencode service set env COMMANDCODE_API_KEY <key>
 *  - connect in the TUI (`/connect` -> Command Code) or:
 *      opencode auth login commandcode --method key
 *
 * Optional overrides:
 *  - COMMANDCODE_CATALOG_URL: alternate catalog URL, or `disabled` to skip fetching.
 *
 * On fetch failure the last successfully fetched catalog is reused from plugin storage.
 */
import { Plugin, Provider, Model } from "@opencode/plugin"

const PROVIDER_ID = "commandcode"
const INTEGRATION_ID = "commandcode"
const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1/"
const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/herouu/opencode-commandcode/main/models.json"
const CACHE_KEY = "catalog"
const FETCH_TIMEOUT_MS = 8000

// Command Code serves OpenAI-style models through its OpenAI-compatible
// /chat/completions route, but Claude models only through the Anthropic
// Messages route (/messages). Register Claude models with the matching runtime.
const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"
const ANTHROPIC_COMPATIBLE = "@opencode/ai/providers/anthropic-compatible"

interface ModelEntry {
  id: string
  name?: string
  reasoning?: boolean
  reasoningEfforts?: string[]
  tool_call?: boolean
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  limit?: { context?: number; output?: number }
  attachment?: boolean
  modalities?: { input?: string[]; output?: string[] }
}

function catalogUrl(): string {
  return process.env.COMMANDCODE_CATALOG_URL?.trim() || DEFAULT_CATALOG_URL
}

async function fetchCatalog(url: string): Promise<ModelEntry[] | null> {
  if (url === "disabled") return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      if (!res.ok) return null
      const data = (await res.json()) as unknown
      if (!Array.isArray(data) || data.length === 0) return null
      if (typeof (data[0] as ModelEntry)?.id !== "string") return null
      return data as ModelEntry[]
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** Claude models must use the Anthropic Messages runtime; everything else is OpenAI-compatible. */
function packageFor(entry: ModelEntry): string {
  const id = entry.id.toLowerCase()
  return id.startsWith("claude") || id.startsWith("anthropic/") ? ANTHROPIC_COMPATIBLE : OPENAI_COMPATIBLE
}

/** Same key mapping the V1 plugin used: part after "/", lowercased. */
function toConfigID(fullID: string): string {
  const slash = fullID.indexOf("/")
  const short = slash >= 0 ? fullID.slice(slash + 1) : fullID
  return short.toLowerCase()
}

function readCache(value: unknown): ModelEntry[] | null {
  if (!value || typeof value !== "object") return null
  const models = (value as { models?: unknown }).models
  if (!Array.isArray(models) || models.length === 0) return null
  if (typeof (models[0] as ModelEntry)?.id !== "string") return null
  return models as ModelEntry[]
}

/** Append a suffix to display names shared by several models, like the V1 plugin did. */
function disambiguateNames(entries: ModelEntry[]) {
  const groups = new Map<string, ModelEntry[]>()
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

function toOpenCodeModels(providerID: string, entries: ModelEntry[]) {
  // Colliding config keys keep the last entry, matching the V1 object mapping.
  const byKey = new Map<string, ModelEntry>()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) continue
    byKey.set(toConfigID(entry.id), entry)
  }
  const picked = [...byKey.values()]
  disambiguateNames(picked)

  const models: ReturnType<typeof Model.Info.default>[] = []
  for (const entry of picked) {
    const id = toConfigID(entry.id)
    const input = entry.modalities?.input?.filter((m) => typeof m === "string" && m.length > 0)
    const output = entry.modalities?.output?.filter((m) => typeof m === "string" && m.length > 0)

    models.push({
      ...Model.Info.default(providerID, id),
      name: entry.name && entry.name.length > 0 ? entry.name : entry.id,
      modelID: entry.id,
      package: packageFor(entry),
      capabilities: {
        tools: entry.tool_call !== false,
        input: input && input.length > 0 ? input : ["text"],
        output: output && output.length > 0 ? output : ["text"],
      },
      limit: {
        context: entry.limit?.context ?? 200_000,
        output: entry.limit?.output ?? 65_536,
      },
      cost: [
        {
          input: entry.cost?.input ?? 0,
          output: entry.cost?.output ?? 0,
          cache: {
            read: entry.cost?.cache_read ?? 0,
            write: entry.cost?.cache_write ?? 0,
          },
        },
      ],
      variants: (entry.reasoningEfforts ?? []).map((effort) => ({
        id: effort,
        settings: { reasoningEffort: effort },
      })),
    })
  }
  return models
}

export default Plugin.define({
  id: "commandcode",
  async setup(ctx) {
    const url = catalogUrl()

    let entries = await fetchCatalog(url)
    let source = "remote"
    if (entries && entries.length > 0) {
      try {
        await ctx.storage.set(CACHE_KEY, { fetchedAt: new Date().toISOString(), url, models: entries })
      } catch {
        // caching is best-effort only
      }
    } else {
      try {
        entries = readCache(await ctx.storage.get(CACHE_KEY))
        source = "cache"
      } catch {
        entries = null
      }
    }

    if (!entries || entries.length === 0) {
      console.warn("[commandcode] no model catalog available (remote fetch failed and no cache)")
      return
    }

    const models = toOpenCodeModels(PROVIDER_ID, entries)

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
        models,
      })
    })

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: ["COMMANDCODE_API_KEY"] },
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "API Key" },
      })
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = "Command Code"
      })
    })

    console.log(`[commandcode] provider ready with ${models.length} models (catalog: ${source})`)
  },
})
