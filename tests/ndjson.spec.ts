import { describe, expect, it } from 'vitest'
import { NdjsonSplitter, parseNdjsonLine } from '../src/transport/ndjson.ts'

const encoder = new TextEncoder()

describe('NdjsonSplitter', () => {
  it('emite apenas linhas completas', () => {
    const splitter = new NdjsonSplitter()
    expect(splitter.push('{"a":1}\n{"b":2}')).toEqual(['{"a":1}'])
    expect(splitter.push('\n')).toEqual(['{"b":2}'])
  })

  it('segura uma linha partida entre chunks', () => {
    const splitter = new NdjsonSplitter()
    expect(splitter.push('{"type":"mess')).toEqual([])
    expect(splitter.push('age_start"}\n')).toEqual(['{"type":"message_start"}'])
  })

  it('segura um caractere multibyte partido no meio', () => {
    // O buffer do pipe corta onde quiser, inclusive no meio de um emoji.
    const bytes = encoder.encode('{"t":"😀"}\n')
    const splitter = new NdjsonSplitter()
    const cut = 8
    expect(splitter.push(bytes.slice(0, cut))).toEqual([])
    const lines = splitter.push(bytes.slice(cut))
    expect(lines).toEqual(['{"t":"😀"}'])
  })

  it('descarta linhas em branco', () => {
    const splitter = new NdjsonSplitter()
    expect(splitter.push('\n\n  \n{"a":1}\n')).toEqual(['{"a":1}'])
  })

  it('libera a ultima linha sem newline no flush', () => {
    const splitter = new NdjsonSplitter()
    expect(splitter.push('{"a":1}')).toEqual([])
    expect(splitter.flush()).toEqual(['{"a":1}'])
    expect(splitter.flush()).toEqual([])
  })
})

describe('parseNdjsonLine', () => {
  it('decodifica JSON valido', () => {
    expect(parseNdjsonLine('{"a":1}')).toEqual({ a: 1 })
  })

  it('devolve undefined em vez de derrubar o stream por um diagnostico solto', () => {
    expect(parseNdjsonLine('Warning: something happened')).toBeUndefined()
  })
})
