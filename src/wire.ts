/**
 * Structural subset of the Anthropic streaming wire vocabulary that this
 * adapter actually consumes. Declared locally rather than imported from
 * `@anthropic-ai/sdk` so the surface we depend on is explicit and narrow: both
 * transports (SDK `stream_event` and `claude -p --output-format stream-json`)
 * emit exactly these shapes, and anything outside them is ignored by design.
 *
 * @module dsh-claude-cli/wire
 */

/** Anthropic token accounting; every field is optional because partial events omit most of them. */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
}

/** Why the provider stopped generating. */
export type WireStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | (string & {})

/** The opening shape of a content block, before any delta arrives. */
export type WireContentBlockStart =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'redacted_thinking'; data?: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  | { type: string; [key: string]: unknown }

/** Incremental payloads carried by `content_block_delta`. */
export type WireDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: string; [key: string]: unknown }

/** One raw streaming event, as emitted by both transports. */
export type WireEvent =
  | { type: 'message_start'; message?: { id?: string; model?: string; usage?: WireUsage } }
  | { type: 'content_block_start'; index: number; content_block: WireContentBlockStart }
  | { type: 'content_block_delta'; index: number; delta: WireDelta }
  | { type: 'content_block_stop'; index: number }
  | {
    type: 'message_delta'
    delta?: { stop_reason?: WireStopReason | null; stop_sequence?: string | null }
    usage?: WireUsage
  }
  | { type: 'message_stop' }
  | { type: 'error'; error?: { type?: string; message?: string } }
  | { type: string; [key: string]: unknown }

/**
 * Narrow an arbitrary parsed JSON value to a wire event.
 * @param value - one decoded NDJSON line or SDK `stream_event` payload.
 * @returns true when the value carries a string `type` tag.
 */
export function isWireEvent(value: unknown): value is WireEvent {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { type?: unknown }).type === 'string'
}
