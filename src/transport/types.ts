/**
 * The seam both transports implement, so the adapter does not care whether a
 * call went through the Claude Agent SDK or a raw `claude -p` subprocess.
 *
 * @module dsh-claude-cli/transport/types
 */

import type { StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { EffortLevel } from '../effort.ts'

/**
 * One image resolved to bytes, ready for a transport with a native channel.
 *
 * The adapter does the resolving because it owns the attachment seam; a
 * transport receives only what it can put on the wire.
 */
export interface TransportImage {
  /** Verified media type; the vocabulary already matches what the API accepts. */
  mediaType: ImageMediaType
  /** Base64-encoded encoded bytes. */
  data: string
}

/** Minimal logging surface, satisfied by the Cordis logger. */
export interface TransportLogger {
  warn(message: string): void
  debug(message: string): void
}

/** One fully-prepared provider call. */
export interface TransportRequest {
  /** The flattened conversation document. */
  prompt: string
  /** The complete system prompt, framing included. */
  systemPrompt: string
  /** Claude Code model id, when the route maps one. */
  model?: string
  /** Reasoning effort for this call; omitted leaves the CLI's own default. */
  effort?: EffortLevel
  /** Tool schemas to publish through the MCP bridge; empty disables the bridge. */
  tools: readonly ToolSchema[]
  /**
   * Images belonging to the newest user turn. Absent or empty keeps the call on
   * the plain string-prompt path; a transport that cannot carry bytes refuses a
   * non-empty list rather than dropping it.
   */
  images?: readonly TransportImage[]
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Override for the `claude` executable. */
  binaryPath?: string
  /** Working directory for the provider process. */
  cwd?: string
  /** Hard ceiling on provider turns; the harness owns the real loop. */
  maxTurns: number
  /** Maximum provider silence, in milliseconds, while a read is outstanding. */
  idleTimeoutMs: number
  logger?: TransportLogger
}

/** A transport turns one request into the harness chunk protocol. */
export type Transport = (request: TransportRequest) => AsyncIterable<StreamChunk>
