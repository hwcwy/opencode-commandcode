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

const PROVIDER_ID = "commandcode"
const INTEGRATION_ID = "commandcode"
const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1/"
const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/herouu/opencode-commandcode/main/models.json"
const CACHE_KEY = "catalog"
const FETCH_TIMEOUT_MS = 8000
const ATTACHMENT_DIR = ".opencode/attachments"

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

    console.log(`[commandcode] provider ready with ${models.length} models (catalog: ${source})`)
  },
})
