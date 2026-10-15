/**
 * Memory error catalog (ERR-01).
 *
 * One vocabulary shared by the tools, the RPC surface, and the audit log.
 * Every failure the plugin can produce has a stable machine-readable code;
 * callers key their handling on `code`, messages are for humans.
 */

export const MEMORY_ERROR_CODES = [
  "routing_violation", // write to the wrong scope (e.g. project-specific fact → personality)
  "invalid_kind", // kind not allowed for the scope
  "invalid_content", // empty or structurally invalid content
  "entry_too_long", // exceeds perEntryCharLimit (or a per-record limit)
  "too_many_lines", // exceeds maxEntryLines (or a per-record limit)
  "overflow", // store cap would be exceeded — consolidate and retry
  "ambiguous_match", // old_text matched more than one entry
  "not_found", // old_text / id matched nothing
  "invalid_status", // illegal lifecycle transition (issue / guardrail)
  "invalid_config", // a config value failed validation
  "invalid_recovery", // unknown or malformed recovery id
] as const

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number]

export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  readonly detail: Record<string, unknown>

  constructor(code: MemoryErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = "MemoryError"
    this.code = code
    this.detail = detail
  }
}

export function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError
}

/** True when the thrown value carries the given catalog code. */
export function hasCode(error: unknown, code: MemoryErrorCode): boolean {
  return isMemoryError(error) && error.code === code
}
