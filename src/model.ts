/**
 * The catalog entry shape, defined once so discovery, the cache, and the
 * adapter all speak it — a pinned model and a discovered one are the same kind
 * of thing and must stay interchangeable.
 *
 * @module dsh-claude-cli/model
 */

import type { EffortLevel } from './effort.ts'

/** One model this route advertises. */
export interface ClaudeCliModel {
  /** Model id as the harness selects it, and as Claude Code receives it. */
  id: string
  /** Human-readable name for model pickers; falls back to the id. */
  name?: string
  /** Optional user-facing distinction. */
  description?: string
  /** Maximum combined request and response context. */
  contextWindow?: number
  /** Per-request output cap materialized when the caller omits one. */
  maxTokens?: number
  /**
   * Effort levels this exact model honors. Absent or empty means the model
   * takes no effort parameter, and the harness shows no effort picker for it —
   * which is the truth for Haiku on the current CLI.
   */
  efforts?: EffortLevel[]
}
