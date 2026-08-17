/**
 * Split a byte stream into NDJSON values.
 *
 * A chunk boundary lands wherever the OS pipe buffer happens to fill, which is
 * routinely mid-line and, for multi-byte UTF-8, mid-character. Both cases are
 * held back until the rest arrives.
 *
 * @module dsh-claude-cli/transport/ndjson
 */

/** Incremental NDJSON decoder over arbitrary byte chunks. */
export class NdjsonSplitter {
  // `stream: true` is what makes a split multi-byte character survive: the
  // decoder keeps the partial sequence instead of emitting a replacement char.
  readonly #decoder = new TextDecoder('utf-8')
  #buffer = ''

  /**
   * Feed one chunk of output.
   * @param chunk - raw bytes, or already-decoded text.
   * @returns every complete line the chunk finished, in order.
   */
  push(chunk: Uint8Array | string): string[] {
    this.#buffer += typeof chunk === 'string'
      ? chunk
      : this.#decoder.decode(chunk, { stream: true })
    if (!this.#buffer.includes('\n')) return []
    const parts = this.#buffer.split('\n')
    // The final part is whatever follows the last newline: either empty, or the
    // start of a line still in flight.
    this.#buffer = parts.pop() ?? ''
    return parts.map((line) => line.trim()).filter((line) => line !== '')
  }

  /**
   * Flush whatever is left once the stream closes.
   * @returns the trailing line, if the producer ended without a newline.
   */
  flush(): string[] {
    const rest = (this.#buffer + this.#decoder.decode()).trim()
    this.#buffer = ''
    return rest === '' ? [] : [rest]
  }
}

/**
 * Decode one NDJSON line.
 * @param line - a single complete line.
 * @returns the parsed value, or `undefined` when the line is not JSON.
 */
export function parseNdjsonLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    // Claude Code occasionally interleaves plain diagnostics on stdout; a line
    // we cannot parse is not a reason to fail the whole stream.
    return undefined
  }
}
