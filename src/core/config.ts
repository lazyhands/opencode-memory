/**
 * Layered configuration (CFG-01).
 *
 * Precedence, lowest → highest:  plugin `options`  <  global config.json  <  project config.json
 *
 * Every effective value remembers which layer it came from (`sources`), so
 * `memory_status` and the TUI can always show value + origin. Malformed JSON
 * never throws: the layer is skipped and a warning is collected. Unknown keys
 * are ignored; known keys with invalid values keep the previous layer's value
 * and collect an `invalid_config` warning.
 */
import { readText } from "./paths.ts"

export type ProtocolMode = "full" | "short" | "off"
export type GuardrailMode = "warn" | "block"

export interface MemoryConfig {
  personalityCharLimit: number
  projectCharLimit: number
  perEntryCharLimit: number
  maxEntryLines: number
  maxInjectChars: number
  jit: boolean
  learnings: { maxIndexTitles: number }
  capture: { toolErrors: boolean; ignoreTools: string[]; maxRecords: number }
  guardrails: { mode: GuardrailMode }
  autoDistillOnCompact: boolean
  audit: { enabled: boolean; retentionDays: number }
  protocol: ProtocolMode
}

export const DEFAULT_CONFIG: MemoryConfig = {
  personalityCharLimit: 1500,
  projectCharLimit: 4000,
  perEntryCharLimit: 180,
  maxEntryLines: 3,
  maxInjectChars: 2400,
  jit: true,
  learnings: { maxIndexTitles: 12 },
  capture: { toolErrors: true, ignoreTools: [], maxRecords: 200 },
  guardrails: { mode: "warn" },
  autoDistillOnCompact: false,
  audit: { enabled: true, retentionDays: 30 },
  protocol: "full",
}

export type ConfigFieldType = "int" | "bool" | "string" | "string[]"

/** Every tunable leaf, as a literal union. */
export type ConfigFieldPath =
  | "personalityCharLimit"
  | "projectCharLimit"
  | "perEntryCharLimit"
  | "maxEntryLines"
  | "maxInjectChars"
  | "jit"
  | "learnings.maxIndexTitles"
  | "capture.toolErrors"
  | "capture.ignoreTools"
  | "capture.maxRecords"
  | "guardrails.mode"
  | "autoDistillOnCompact"
  | "audit.enabled"
  | "audit.retentionDays"
  | "protocol"

export interface ConfigField {
  path: ConfigFieldPath
  type: ConfigFieldType
  description: string
}

/** Flat catalog of every tunable leaf — drives validation, status and the TUI editor. */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  { path: "personalityCharLimit", type: "int", description: "Total char cap for personality entries" },
  { path: "projectCharLimit", type: "int", description: "Total char cap for project entries" },
  { path: "perEntryCharLimit", type: "int", description: "Max chars for a single entry" },
  { path: "maxEntryLines", type: "int", description: "Max lines for a single entry" },
  { path: "maxInjectChars", type: "int", description: "Budget for the injected memory block" },
  { path: "jit", type: "bool", description: "Surface turn-relevant items (JIT section)" },
  { path: "learnings.maxIndexTitles", type: "int", description: "Lesson titles shown in the index" },
  { path: "capture.toolErrors", type: "bool", description: "Auto-capture tool failures as guardrails" },
  { path: "capture.ignoreTools", type: "string[]", description: "Tools excluded from failure capture" },
  { path: "capture.maxRecords", type: "int", description: "Max guardrail records kept" },
  { path: "guardrails.mode", type: "string", description: "Default pre-flight behavior: warn | block" },
  { path: "autoDistillOnCompact", type: "bool", description: "Draft lessons at compaction (costs a model call)" },
  { path: "audit.enabled", type: "bool", description: "Write audit.jsonl events" },
  { path: "audit.retentionDays", type: "int", description: "Audit log retention window" },
  { path: "protocol", type: "string", description: "Injected protocol text: full | short | off" },
]

export const CONFIG_FIELD_PATHS: readonly ConfigFieldPath[] = CONFIG_FIELDS.map((f) => f.path)

export const CONFIG_SOURCE_DEFAULT = "default"
export const CONFIG_SOURCE_PLUGIN = "plugin options"

export interface LoadedConfig {
  config: MemoryConfig
  /** For every field: the layer providing the effective value ("default", "plugin options", or a file path). */
  sources: Record<ConfigFieldPath, string>
  /** Non-fatal problems (malformed JSON, invalid values) — surfaced by memory_status and the TUI. */
  warnings: string[]
}

export function cloneDefaultConfig(): MemoryConfig {
  return structuredClone(DEFAULT_CONFIG)
}

// ---------------------------------------------------------------------------
// Field accessors (exhaustive switch — a new field is a compile error)
// ---------------------------------------------------------------------------

function getRawField(source: Record<string, unknown>, path: ConfigFieldPath): unknown {
  let current: unknown = source
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setField(config: MemoryConfig, path: ConfigFieldPath, value: unknown): void {
  switch (path) {
    case "personalityCharLimit":
      config.personalityCharLimit = value as number
      break
    case "projectCharLimit":
      config.projectCharLimit = value as number
      break
    case "perEntryCharLimit":
      config.perEntryCharLimit = value as number
      break
    case "maxEntryLines":
      config.maxEntryLines = value as number
      break
    case "maxInjectChars":
      config.maxInjectChars = value as number
      break
    case "jit":
      config.jit = value as boolean
      break
    case "learnings.maxIndexTitles":
      config.learnings.maxIndexTitles = value as number
      break
    case "capture.toolErrors":
      config.capture.toolErrors = value as boolean
      break
    case "capture.ignoreTools":
      config.capture.ignoreTools = value as string[]
      break
    case "capture.maxRecords":
      config.capture.maxRecords = value as number
      break
    case "guardrails.mode":
      config.guardrails.mode = value as GuardrailMode
      break
    case "autoDistillOnCompact":
      config.autoDistillOnCompact = value as boolean
      break
    case "audit.enabled":
      config.audit.enabled = value as boolean
      break
    case "audit.retentionDays":
      config.audit.retentionDays = value as number
      break
    case "protocol":
      config.protocol = value as ProtocolMode
      break
  }
}

type Validator = (value: unknown) => boolean

const isPositiveInt: Validator = (v) => typeof v === "number" && Number.isInteger(v) && v > 0
const isBoolean: Validator = (v) => typeof v === "boolean"
const isStringArray: Validator = (v) => Array.isArray(v) && v.every((item) => typeof item === "string")
const oneOf =
  (...allowed: readonly string[]): Validator =>
  (v) =>
    typeof v === "string" && allowed.includes(v)

export function isConfigFieldPath(key: string): key is ConfigFieldPath {
  return (CONFIG_FIELD_PATHS as readonly string[]).includes(key)
}

/** `null` when the value is valid for the field, otherwise a human-readable reason. */
export function validateFieldValue(path: ConfigFieldPath, value: unknown): string | null {
  if (FIELD_VALIDATORS[path](value)) return null
  const expected: Record<ConfigFieldType, string> = {
    int: "a positive integer",
    bool: "true or false",
    string: "a string",
    "string[]": "an array of strings",
  }
  const field = CONFIG_FIELDS.find((item) => item.path === path)
  return `"${JSON.stringify(value)}" is invalid for ${path} — expected ${expected[field?.type ?? "string"]}`
}

/** Read a leaf's effective value from a loaded config (dotted path). */
export function readFieldValue(config: MemoryConfig, path: ConfigFieldPath): unknown {
  return getRawField(config as unknown as Record<string, unknown>, path)
}

/** Deep-set a dotted path on a raw JSON object (for editing config files in place). */
export function setRawField(target: Record<string, unknown>, path: ConfigFieldPath, value: unknown): void {
  const parts = path.split(".")
  let current = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? ""
    const next = current[part]
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1] ?? path] = value
}

const FIELD_VALIDATORS: Record<ConfigFieldPath, Validator> = {
  personalityCharLimit: isPositiveInt,
  projectCharLimit: isPositiveInt,
  perEntryCharLimit: isPositiveInt,
  maxEntryLines: isPositiveInt,
  maxInjectChars: isPositiveInt,
  jit: isBoolean,
  "learnings.maxIndexTitles": isPositiveInt,
  "capture.toolErrors": isBoolean,
  "capture.ignoreTools": isStringArray,
  "capture.maxRecords": isPositiveInt,
  "guardrails.mode": oneOf("warn", "block"),
  autoDistillOnCompact: isBoolean,
  "audit.enabled": isBoolean,
  "audit.retentionDays": isPositiveInt,
  protocol: oneOf("full", "short", "off"),
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadConfigInput {
  /** Plugin `options` from the opencode.json plugin entry (base layer). */
  options?: Record<string, unknown> | undefined
  /** Global `memory/config.json` path. */
  globalPath?: string | undefined
  /** Project `.opencode/memory/config.json` path. */
  projectPath?: string | undefined
}

interface ConfigLayer {
  source: string
  raw: unknown
}

function loadLayer(source: string, path: string, warnings: string[]): ConfigLayer | null {
  const text = readText(path)
  if (text === null) return null
  try {
    return { source, raw: JSON.parse(text) as unknown }
  } catch (error) {
    warnings.push(`malformed JSON in ${source} — layer ignored (${String(error)})`)
    return null
  }
}

export function loadConfig(input: LoadConfigInput = {}): LoadedConfig {
  const config = cloneDefaultConfig()
  const sources = {} as Record<ConfigFieldPath, string>
  for (const path of CONFIG_FIELD_PATHS) sources[path] = CONFIG_SOURCE_DEFAULT
  const warnings: string[] = []

  const layers: ConfigLayer[] = [{ source: CONFIG_SOURCE_PLUGIN, raw: input.options }]
  if (input.globalPath) {
    const layer = loadLayer(input.globalPath, input.globalPath, warnings)
    if (layer) layers.push(layer)
  }
  if (input.projectPath) {
    const layer = loadLayer(input.projectPath, input.projectPath, warnings)
    if (layer) layers.push(layer)
  }

  for (const layer of layers) {
    if (layer.raw === undefined) continue
    if (layer.raw === null || typeof layer.raw !== "object" || Array.isArray(layer.raw)) {
      warnings.push(`config layer "${layer.source}" is not a JSON object — ignored`)
      continue
    }
    const object = layer.raw as Record<string, unknown>
    for (const field of CONFIG_FIELD_PATHS) {
      const value = getRawField(object, field)
      if (value === undefined) continue
      if (!FIELD_VALIDATORS[field](value)) {
        warnings.push(
          `invalid_config: ${layer.source}: "${field}" = ${JSON.stringify(value)} is invalid — keeping value from ${sources[field]}`,
        )
        continue
      }
      setField(config, field, value)
      sources[field] = layer.source
    }
  }

  return { config, sources, warnings }
}
