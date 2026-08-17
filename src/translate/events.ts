/**
 * Translate the Anthropic streaming wire vocabulary into the harness
 * {@link StreamChunk} protocol.
 *
 * The contract this module exists to satisfy (from `@deepseek-ai/dsh-llm`):
 * every `block-start` is matched by a `block-end`, block indexes are sequential
 * across the whole call, `usage` is emitted before the terminal `finish`, and
 * `finish` is the last chunk with nothing after it.
 *
 * Wire block indexes restart at 0 for every provider message, so they are
 * remapped onto one monotonic counter here — otherwise a second message would
 * reopen index 0 and break correlation.
 *
 * @module dsh-claude-cli/translate/events
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  ContentBlockType,
  FinishReason,
  LlmFailure,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { WireEvent, WireStopReason, WireUsage } from '../wire.ts'

/** How a translated stream reached its end. */
export type StreamOutcome =
  /** The provider ran to completion; the wire stop reason decides the finish. */
  | { kind: 'natural' }
  /**
   * We stopped the provider ourselves right after capturing a tool call, so it
   * could not execute it. The turn really did end in tool calls, and that is
   * what the loop must see — not an abort.
   */
  | { kind: 'intercepted-tool-calls' }
  /** The caller's `AbortSignal` fired. */
  | { kind: 'aborted'; failure: LlmFailure }
  /** The provider or transport failed. */
  | { kind: 'error'; failure: LlmFailure }

/** Accumulated state for one open content block. */
interface OpenBlock {
  index: number
  blockType: ContentBlockType
  text: string
  toolCallId?: CallId
  toolName?: string
  toolArguments: string
  /** `input` seen on `content_block_start`, used when no delta ever arrives. */
  toolSeedInput?: unknown
}

/** Wire block tag to harness block tag. */
function blockTypeOf(wireType: string): ContentBlockType | undefined {
  switch (wireType) {
    case 'text': return 'text'
    case 'thinking':
    case 'redacted_thinking': return 'reasoning'
    case 'tool_use': return 'tool-call'
    // Unknown block kinds are skipped rather than guessed: emitting a block we
    // cannot assemble would leave a `block-start` we can never close.
    default: return undefined
  }
}

/**
 * Overlay a later wire usage report onto an earlier one for the SAME message.
 * Anthropic restates cumulative totals on `message_delta` rather than sending
 * increments, so the later report replaces field by field — adding them would
 * double-count every token the message already reported at `message_start`.
 */
function overlayUsage(base: WireUsage, next: WireUsage | undefined): WireUsage {
  return next === undefined ? base : { ...base, ...next }
}

/** Anthropic counts already exclude cache from `input_tokens`, which is the disjointness TokenUsage requires. */
function toTokenUsage(wire: WireUsage): TokenUsage {
  const thinking = wire.output_tokens_details?.thinking_tokens
  return {
    inputTokens: wire.input_tokens ?? 0,
    outputTokens: wire.output_tokens ?? 0,
    ...wire.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadTokens: wire.cache_read_input_tokens },
    ...wire.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteTokens: wire.cache_creation_input_tokens },
    ...thinking === undefined ? {} : { reasoningTokens: thinking },
  }
}

/** Sum two optional counters, keeping the field absent only when neither side reported it. */
function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/** Add usage across separate messages, where the counts genuinely accumulate. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheRead = addOptional(a.cacheReadTokens, b.cacheReadTokens)
  const cacheWrite = addOptional(a.cacheWriteTokens, b.cacheWriteTokens)
  const reasoning = addOptional(a.reasoningTokens, b.reasoningTokens)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

/** Map the provider stop reason onto the harness finish vocabulary. */
function finishFor(stopReason: WireStopReason | undefined, sawToolCall: boolean): FinishReason {
  if (stopReason === 'tool_use' || sawToolCall) return { kind: 'tool-calls' }
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** Construction-time knobs for one translated call. */
export interface StreamTranslatorOptions {
  /**
   * Rewrite a provider tool name into the name the harness asked for. The MCP
   * bridge namespaces every tool as `mcp__<server>__<tool>`, and the loop only
   * recognizes its own names, so the mapping is applied once at block start —
   * that way the delta and the assembled block can never disagree.
   */
  toolName?: (wireName: string) => string
}

/**
 * Stateful translator for one model call. Feed every wire event through
 * {@link push}, then close the call exactly once with {@link end}.
 */
export class StreamTranslator {
  readonly #toolName: (wireName: string) => string

  constructor(options: StreamTranslatorOptions = {}) {
    this.#toolName = options.toolName ?? ((name) => name)
  }

  /** Next harness block index to hand out; never reused within one call. */
  #nextIndex = 0
  /** Wire index to open block, cleared at each message boundary. */
  #open = new Map<number, OpenBlock>()
  /** Converted totals of messages that already finished reporting. */
  #settledUsage: TokenUsage = ZERO_USAGE
  /** Latest cumulative wire report for the message currently streaming. */
  #currentUsage: WireUsage = {}
  #stopReason: WireStopReason | undefined
  #sawToolCall = false
  #emittedBlock = false
  #ended = false

  /** Whether any tool-call block was seen, which the transport uses to stop the provider early. */
  get sawToolCall(): boolean {
    return this.#sawToolCall
  }

  /**
   * Feed one wire event.
   * @param event - a decoded stream event from either transport.
   * @returns the chunks this event produced, in emission order.
   */
  *push(event: WireEvent): Iterable<StreamChunk> {
    switch (event.type) {
      case 'message_start': {
        // A new message restarts wire indexes, so anything still open belongs
        // to the previous one and is closed before the numbering resets.
        yield* this.#closeOpenBlocks()
        this.#settledUsage = addUsage(this.#settledUsage, toTokenUsage(this.#currentUsage))
        const start = event as Extract<WireEvent, { type: 'message_start' }>
        this.#currentUsage = start.message?.usage ?? {}
        return
      }

      case 'content_block_start': {
        const start = event as Extract<WireEvent, { type: 'content_block_start' }>
        const blockType = blockTypeOf(String(start.content_block?.type))
        if (blockType === undefined) return
        const index = this.#nextIndex++
        const block: OpenBlock = {
          index,
          blockType,
          text: typeof (start.content_block as { text?: unknown }).text === 'string'
            ? (start.content_block as { text: string }).text
            : '',
          toolArguments: '',
        }
        if (blockType === 'tool-call') {
          const seed = start.content_block as { id?: unknown; name?: unknown; input?: unknown }
          block.toolCallId = CallId(typeof seed.id === 'string' ? seed.id : `call_${index}`)
          block.toolName = typeof seed.name === 'string' ? this.#toolName(seed.name) : ''
          block.toolSeedInput = seed.input
          this.#sawToolCall = true
        }
        this.#open.set(start.index, block)
        yield { type: 'block-start', index, blockType }
        if (block.text !== '') yield { type: 'text-delta', index, text: block.text }
        return
      }

      case 'content_block_delta': {
        const delta = event as Extract<WireEvent, { type: 'content_block_delta' }>
        const block = this.#open.get(delta.index)
        if (block === undefined) return
        const payload = delta.delta
        if (payload.type === 'text_delta' && typeof payload.text === 'string') {
          block.text += payload.text
          yield { type: 'text-delta', index: block.index, text: payload.text }
        } else if (payload.type === 'thinking_delta' && typeof payload.thinking === 'string') {
          block.text += payload.thinking
          yield { type: 'reasoning-delta', index: block.index, text: payload.thinking }
        } else if (payload.type === 'input_json_delta' && typeof payload.partial_json === 'string') {
          // An empty first delta carries no JSON but still marks the block as
          // streaming arguments; forwarding it would be a no-op chunk.
          if (payload.partial_json === '') return
          block.toolArguments += payload.partial_json
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: block.toolCallId ?? CallId(`call_${block.index}`),
            ...block.toolName === undefined || block.toolName === '' ? {} : { name: block.toolName },
            argumentsDelta: payload.partial_json,
          }
        }
        return
      }

      case 'content_block_stop': {
        const stop = event as Extract<WireEvent, { type: 'content_block_stop' }>
        const block = this.#open.get(stop.index)
        if (block === undefined) return
        this.#open.delete(stop.index)
        yield this.#endBlock(block)
        return
      }

      case 'message_delta': {
        const message = event as Extract<WireEvent, { type: 'message_delta' }>
        const reason = message.delta?.stop_reason
        if (reason !== undefined && reason !== null) this.#stopReason = reason
        this.#currentUsage = overlayUsage(this.#currentUsage, message.usage)
        return
      }

      // `message_stop` and `error` carry nothing this protocol needs: the stop
      // reason already arrived on `message_delta`, and failures are classified
      // by the transport and delivered through `end()`.
      default:
        return
    }
  }

  /**
   * Close the call. Emits any unfinished block, then `usage`, then `finish`.
   * @param outcome - how the stream ended.
   * @returns the terminal chunks, with `finish` last.
   * @throws LlmError with `EMPTY_RESPONSE` when a successful call produced no block at all.
   */
  *end(outcome: StreamOutcome): Iterable<StreamChunk> {
    if (this.#ended) return
    this.#ended = true
    yield* this.#closeOpenBlocks()

    const usage = addUsage(this.#settledUsage, toTokenUsage(this.#currentUsage))
    yield { type: 'usage', usage }

    if (outcome.kind === 'aborted') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: outcome.failure } }
      return
    }
    if (outcome.kind === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: outcome.failure } }
      return
    }
    if (!this.#emittedBlock) {
      // A terminal stop with zero content is a degenerate completion: the
      // harness wants it classified rather than surfaced as an empty message.
      throw new LlmError(
        'claude-cli: the provider completed without emitting any content block',
        EMPTY_RESPONSE_CODE,
      )
    }
    const reason = outcome.kind === 'intercepted-tool-calls'
      ? { kind: 'tool-calls' as const }
      : finishFor(this.#stopReason, this.#sawToolCall)
    yield { type: 'finish', reason }
  }

  /** Close every block still open, lowest wire index first for stable ordering. */
  *#closeOpenBlocks(): Iterable<StreamChunk> {
    if (this.#open.size === 0) return
    const pending = [...this.#open.entries()].sort(([a], [b]) => a - b)
    this.#open.clear()
    for (const [, block] of pending) yield this.#endBlock(block)
  }

  /** Assemble one open block into its terminal `block-end` chunk. */
  #endBlock(block: OpenBlock): StreamChunk {
    this.#emittedBlock = true
    return { type: 'block-end', index: block.index, block: assembleBlock(block) }
  }
}

/** Build the finished content block an open accumulator represents. */
function assembleBlock(block: OpenBlock): ContentBlock {
  if (block.blockType === 'tool-call') {
    return {
      type: 'tool-call',
      id: block.toolCallId ?? CallId(`call_${block.index}`),
      name: block.toolName ?? '',
      // No delta ever arrived when the provider inlined the whole input on
      // `content_block_start`; the seed is then the only source of arguments.
      arguments: block.toolArguments !== ''
        ? block.toolArguments
        : JSON.stringify(block.toolSeedInput ?? {}),
    }
  }
  if (block.blockType === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'text', text: block.text }
}
