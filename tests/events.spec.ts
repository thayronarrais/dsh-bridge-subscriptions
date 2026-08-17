import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { StreamTranslator } from '../src/translate/events.ts'
import type { StreamOutcome } from '../src/translate/events.ts'
import { isWireEvent } from '../src/wire.ts'
import type { WireEvent } from '../src/wire.ts'

/** Load a recorded NDJSON fixture, dropping the transport-only `sdk_*` lines. */
function fixture(name: string): WireEvent[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}.ndjson`, import.meta.url))
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown)
    .filter(isWireEvent)
    .filter((event) => !event.type.startsWith('sdk_'))
}

/** Run a whole fixture through the translator and collect every chunk. */
function translate(
  events: WireEvent[],
  outcome: StreamOutcome = { kind: 'natural' },
  toolName: (n: string) => string = (n) => n.replace(/^mcp__[^_]+__/, ''),
): StreamChunk[] {
  const translator = new StreamTranslator({ toolName })
  const chunks: StreamChunk[] = []
  for (const event of events) chunks.push(...translator.push(event))
  chunks.push(...translator.end(outcome))
  return chunks
}

/**
 * The invariants `@deepseek-ai/dsh-llm` documents on StreamChunk. Asserted on
 * every case rather than spot-checked, because a violation here is exactly the
 * kind of bug that only shows up as a corrupted transcript at runtime.
 */
function expectProtocolInvariants(chunks: StreamChunk[]): void {
  const finishAt = chunks.findIndex((c) => c.type === 'finish')
  expect(finishAt, 'stream must terminate with a finish chunk').toBeGreaterThanOrEqual(0)
  expect(finishAt, 'nothing may follow finish').toBe(chunks.length - 1)

  const usageAt = chunks.findIndex((c) => c.type === 'usage')
  if (usageAt >= 0) expect(usageAt, 'usage must precede finish').toBeLessThan(finishAt)

  const open = new Set<number>()
  let expectedIndex = 0
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      expect(chunk.index, 'block indexes must be sequential').toBe(expectedIndex++)
      expect(open.has(chunk.index), 'a block index may not reopen').toBe(false)
      open.add(chunk.index)
    } else if (chunk.type === 'block-end') {
      expect(open.has(chunk.index), 'block-end must match an open block-start').toBe(true)
      open.delete(chunk.index)
    }
  }
  expect([...open], 'every block-start must be closed by a block-end').toEqual([])
}

describe('StreamTranslator — texto puro', () => {
  const chunks = translate(fixture('text-plain'))

  it('respeita o contrato de StreamChunk', () => {
    expectProtocolInvariants(chunks)
  })

  it('reconstroi o texto a partir dos deltas', () => {
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('hello from claude code')
  })

  it('fecha o bloco com o texto completo', () => {
    const end = chunks.find((c) => c.type === 'block-end')
    expect(end).toMatchObject({ index: 0, block: { type: 'text', text: 'hello from claude code' } })
  })

  it('termina em stop', () => {
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reporta usage com contagens disjuntas', () => {
    const usage = chunks.find((c) => c.type === 'usage')
    // input_tokens ja exclui o cache no formato Anthropic, que e exatamente a
    // disjuncao que TokenUsage exige; o input faturado e a soma dos tres.
    // message_delta reafirma os totais da mensagem (output 8), nao um
    // incremento sobre o output 1 de message_start — somar dobraria a conta.
    expect(usage).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 2, outputTokens: 8, cacheWriteTokens: 28098, cacheReadTokens: 0 },
    })
  })
})

describe('StreamTranslator — tool call completa', () => {
  const chunks = translate(fixture('tool-call-complete'))

  it('respeita o contrato de StreamChunk', () => {
    expectProtocolInvariants(chunks)
  })

  it('emite texto e tool-call como blocos sequenciais distintos', () => {
    expect(chunks.filter((c) => c.type === 'block-start')).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
    ])
  })

  it('remove o namespace mcp__ do nome da tool', () => {
    const deltas = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta',
    )
    expect(deltas.every((d) => d.name === 'get_weather')).toBe(true)
  })

  it('acumula os argumentos em JSON valido no block-end', () => {
    const end = chunks.find((c) => c.type === 'block-end' && c.index === 1)
    expect(end).toMatchObject({
      block: { type: 'tool-call', id: 'toolu_01CompleteWeather', name: 'get_weather' },
    })
    const block = (end as Extract<StreamChunk, { type: 'block-end' }>).block
    const args = (block as { arguments: string }).arguments
    expect(JSON.parse(args)).toEqual({ city: 'Recife', unit: 'celsius' })
  })

  it('nao emite delta para o input_json_delta vazio de abertura', () => {
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas.every((d) => (d as { argumentsDelta: string }).argumentsDelta !== '')).toBe(true)
  })

  it('termina em tool-calls', () => {
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})

describe('StreamTranslator — tool call interceptada (abortada antes do stop)', () => {
  // Fixture real: o adapter aborta o Claude Code assim que ve a tool call, para
  // que ele nao a execute. O stream termina sem content_block_stop.
  const events = fixture('tool-call-intercepted')
  const chunks = translate(events, { kind: 'intercepted-tool-calls' })

  it('respeita o contrato mesmo com o bloco truncado', () => {
    expectProtocolInvariants(chunks)
  })

  it('fecha o bloco pendente com os argumentos recebidos ate o corte', () => {
    const end = chunks.find((c) => c.type === 'block-end')
    expect(end).toBeDefined()
    const block = (end as Extract<StreamChunk, { type: 'block-end' }>).block as { arguments: string }
    expect(JSON.parse(block.arguments)).toEqual({ city: 'Recife', unit: 'celsius' })
  })

  it('reporta tool-calls, nao aborted — o turno realmente terminou em tool call', () => {
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('sinaliza sawToolCall para o transporte poder cortar cedo', () => {
    const translator = new StreamTranslator()
    expect(translator.sawToolCall).toBe(false)
    for (const event of events) [...translator.push(event)]
    expect(translator.sawToolCall).toBe(true)
  })
})

describe('StreamTranslator — encerramentos anormais', () => {
  const failure = { message: 'boom', code: 'RATE_LIMIT' }

  it('propaga abort como finish aborted', () => {
    const chunks = translate(fixture('text-plain'), { kind: 'aborted', failure })
    expectProtocolInvariants(chunks)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure } })
  })

  it('propaga falha de negocio como finish error', () => {
    const chunks = translate(fixture('text-plain'), { kind: 'error', failure })
    expectProtocolInvariants(chunks)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure } })
  })

  it('classifica resposta vazia como EMPTY_RESPONSE em vez de mensagem vazia', () => {
    const translator = new StreamTranslator()
    ;[...translator.push({ type: 'message_start', message: { usage: { input_tokens: 1 } } })]
    ;[...translator.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })]
    expect(() => [...translator.end({ kind: 'natural' })])
      .toThrowError(expect.objectContaining({ code: 'EMPTY_RESPONSE' }) as unknown as typeof LlmError)
  })

  it('e idempotente: end() duas vezes nao emite um segundo finish', () => {
    const translator = new StreamTranslator()
    for (const event of fixture('text-plain')) [...translator.push(event)]
    expect([...translator.end({ kind: 'natural' })].length).toBeGreaterThan(0)
    expect([...translator.end({ kind: 'natural' })]).toEqual([])
  })

  it('acumula usage entre mensagens distintas, mas nao dentro de uma', () => {
    const chunks = translate([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
      { type: 'content_block_stop', index: 0 },
      // Reafirma o total da mensagem 1: output vira 30, nao 31.
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 30 } },
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 7 } },
    ])
    expect(chunks.find((c) => c.type === 'usage')).toMatchObject({
      usage: { inputTokens: 15, outputTokens: 37 },
    })
  })

  it('fecha blocos de uma mensagem anterior quando outra comeca', () => {
    const chunks = translate([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'primeira' } },
      // Sem content_block_stop: a proxima mensagem reinicia os indices do wire.
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'segunda' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])
    expectProtocolInvariants(chunks)
    expect(chunks.filter((c) => c.type === 'block-end').map((c) => (c as { index: number }).index))
      .toEqual([0, 1])
  })
})
