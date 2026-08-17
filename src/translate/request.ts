/**
 * Flatten a harness conversation into the single prompt Claude Code accepts.
 *
 * `claude -p` and the SDK's string prompt are both one-shot: there is no
 * multi-turn message array to fill, so the transcript is rendered into one
 * delimited document. XML-ish tags are used because they survive nesting inside
 * arbitrary user text far better than markdown fences, which model output is
 * full of.
 *
 * The rendered prompt goes to the provider over stdin or the SDK's own channel,
 * never through `argv` — Windows `cmd.exe` truncates a command line at roughly
 * 8191 characters, and POSIX has `ARG_MAX`.
 *
 * @module dsh-claude-cli/translate/request
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Default prompt budget in bytes; generous, since the window is a million tokens. */
export const DEFAULT_MAX_PROMPT_BYTES = 2_000_000

/** Marker inserted where history was dropped, so the model knows the record is partial. */
const TRUNCATION_NOTICE = '<truncated reason="prompt budget exceeded" />'

const encoder = new TextEncoder()

/** Byte length, not character length: the budget exists to protect a byte-oriented pipe. */
function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Escape the delimiters so conversation text can never forge a tag. */
function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Escape a value going inside an attribute. Quotes matter here and nowhere
 * else: a call id or tool name carrying one would otherwise close the attribute
 * early and let the rest of the value be read as markup.
 */
function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

/** Render one content block. Unknown block kinds are reported, never dropped in silence. */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return escapeText(block.text)
    case 'reasoning':
      return `<reasoning>${escapeText(block.text)}</reasoning>`
    case 'tool-call':
      return `<tool_call id="${escapeAttr(block.id)}" name="${escapeAttr(block.name)}">`
        + `${escapeText(block.arguments)}</tool_call>`
    case 'tool-result': {
      const body = block.content.map(renderBlock).join('\n')
      return `<tool_result call_id="${escapeAttr(block.toolCallId)}"`
        + ` is_error="${block.isError === true}">${body}</tool_result>`
    }
    case 'image': {
      // Only reachable for images left behind by `splitTrailingImages` — an
      // older turn, or a turn that is not the user's. The bytes are not resent,
      // so the note stands in for them and says why rather than pretending the
      // block was never there.
      const name = block.attachment.name
      return `<image${name === undefined ? '' : ` name="${escapeAttr(name)}"`}`
        + ' note="sent earlier in this conversation; bytes not resent" />'
    }
    default:
      return `<unsupported_block type="${escapeText(String((block as { type: string }).type))}" />`
  }
}

/** Render one message as a self-contained, independently droppable chunk. */
function renderMessage(message: Message): string {
  const body = message.content.map(renderBlock).join('\n')
  return `<${message.role}>\n${body}\n</${message.role}>`
}

/**
 * Split the image blocks off the newest turn.
 *
 * Only the last message, and only when it is the user's: those are the bytes
 * the caller is asking about right now, and they are the ones the SDK's
 * streaming-input channel can carry natively. Images further back stay in the
 * document as notes — resending every image on every turn would put the whole
 * conversation's base64 on the wire each round.
 *
 * @param messages - the ordered conversation.
 * @returns the conversation with the newest turn's images removed, and those images.
 */
function splitTrailingImages(messages: readonly Message[]): {
  messages: readonly Message[]
  images: readonly ImageAttachmentRef[]
} {
  const last = messages.at(-1)
  if (last === undefined || last.role !== 'user') return { messages, images: [] }

  const images: ImageAttachmentRef[] = []
  /** Remove image blocks at any depth, collecting them in encounter order. */
  const strip = (block: ContentBlock): readonly ContentBlock[] => {
    if (block.type === 'image') {
      images.push(block.attachment)
      return []
    }
    // Tool results nest their own blocks, and that is where `read_image` puts
    // the bytes: a text envelope plus an image block. Scanning only the top
    // level left exactly that case rendering as a note about missing bytes.
    if (block.type === 'tool-result') {
      return [{ ...block, content: block.content.flatMap(strip) }]
    }
    return [block]
  }

  const content = last.content.flatMap(strip)
  if (images.length === 0) return { messages, images: [] }
  return { messages: [...messages.slice(0, -1), { ...last, content } as Message], images }
}

/** What the transport needs to send, after flattening and budgeting. */
export interface RenderedRequest {
  /** The full conversation document. */
  prompt: string
  /** Whether history had to be dropped to fit the budget. */
  truncated: boolean
  /**
   * Images from the newest user turn, carried outside the document so a
   * transport with a native channel can send the real bytes.
   */
  images: readonly ImageAttachmentRef[]
}

/** Knobs for one render. */
export interface RenderOptions {
  /** Byte ceiling for the rendered conversation; defaults to {@link DEFAULT_MAX_PROMPT_BYTES}. */
  maxPromptBytes?: number
}

/**
 * Flatten the conversation into one prompt, dropping the oldest turns first
 * when it does not fit.
 *
 * Truncation works on whole messages. Cutting inside one would risk splitting a
 * `tool_call` payload down the middle and handing the model a fragment of JSON
 * as if it were the whole argument list.
 *
 * @param messages - the ordered conversation from `GenerateOptions.messages`.
 * @param options - the byte budget for this render.
 * @returns the prompt document and whether anything was dropped.
 */
export function renderConversation(
  messages: readonly Message[],
  options: RenderOptions = {},
): RenderedRequest {
  const budget = options.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES
  const { messages: pending, images } = splitTrailingImages(messages)
  const chunks = pending.map(renderMessage)

  const total = chunks.reduce((sum, chunk) => sum + byteLength(chunk) + 1, 0)
  if (total <= budget) {
    return { prompt: wrap(chunks), truncated: false, images }
  }

  // Walk backwards: the newest turns are the ones the model actually needs, and
  // the most recent message is kept even when it alone blows the budget —
  // sending nothing would be a worse failure than sending too much.
  const kept: string[] = []
  let used = byteLength(TRUNCATION_NOTICE) + 1
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i]
    if (chunk === undefined) continue
    const cost = byteLength(chunk) + 1
    if (kept.length > 0 && used + cost > budget) break
    kept.unshift(chunk)
    used += cost
  }
  return { prompt: wrap([TRUNCATION_NOTICE, ...kept]), truncated: true, images }
}

/** Wrap the rendered turns in the outer conversation element. */
function wrap(chunks: readonly string[]): string {
  return `<conversation>\n${chunks.join('\n')}\n</conversation>`
}

/**
 * Build the system prompt that turns Claude Code into a plain completion
 * endpoint for this call.
 *
 * The harness system prompt is passed through verbatim; the framing around it
 * exists only to suppress Claude Code's own agentic reflexes, which would
 * otherwise compete with the loop that is actually driving this request.
 *
 * @param system - `GenerateOptions.system`, when the caller supplied one.
 * @param hasTools - whether this call published tools through the MCP bridge.
 * @returns the complete system prompt for the provider.
 */
export function buildSystemPrompt(system: string | undefined, hasTools: boolean): string {
  const framing = [
    'You are being used as a stateless completion endpoint by an external agent harness.',
    'The conversation below is the complete context. Respond only with the next assistant turn.',
    'Do not use your own file, shell, or search tools; the harness owns all execution.',
  ]
  if (hasTools) {
    framing.push(
      'When a tool is needed, call it through the provided tool interface and stop.'
      + ' The harness executes it and will call you again with the result.',
    )
  }
  const base = framing.join(' ')
  return system === undefined || system.trim() === '' ? base : `${base}\n\n${system}`
}
