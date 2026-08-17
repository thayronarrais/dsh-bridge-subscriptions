/**
 * The seam both transports implement, so the adapter does not care whether a
 * call went through the Claude Agent SDK or a raw `claude -p` subprocess.
 *
 * @module dsh-claude-cli/transport/types
 */

import type { StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { EffortLevel } from '../effort.ts'

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
