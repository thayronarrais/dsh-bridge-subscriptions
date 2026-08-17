import { describe, expect, it } from 'vitest'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter } from '../src/adapter.ts'
import type { ClaudeCliConnection } from '../src/adapter.ts'
import { ModelCatalog } from '../src/catalog.ts'
import type { ClaudeCliModel } from '../src/model.ts'
import type { TransportRequest } from '../src/transport/types.ts'

/** Mirrors what the real CLI reports: every model but Haiku takes an effort. */
const CATALOG: ClaudeCliModel[] = [
  { id: 'opus[1m]', name: 'Opus (1M context) · claude-opus-5[1m]', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', name: 'Sonnet · claude-sonnet-5', efforts: ['low', 'medium', 'high'] },
  { id: 'haiku', name: 'Haiku · claude-haiku-4-5-20251001' },
]

function connection(overrides: Partial<ClaudeCliConnection> = {}): ClaudeCliConnection {
  return {
    transport: 'sdk',
    models: [],
    discoverModels: true,
    modelCacheTtlMs: 60_000,
    defaultContextWindow: 200_000,
    maxTurns: 2,
    streamIdleTimeoutMs: 60_000,
    maxPromptBytes: 2_000_000,
    ...overrides,
  }
}

/** Captures the request the adapter hands the transport, without spawning a CLI. */
function adapter(overrides: Partial<ClaudeCliConnection> = {}): {
  instance: ClaudeCliAdapter
  sent: { request?: TransportRequest }
} {
  const resolved = connection(overrides)
  const sent: { request?: TransportRequest } = {}
  const instance = new ClaudeCliAdapter({
    connection: () => resolved,
    catalog: new ModelCatalog({
      configured: () => [],
      discover: () => true,
      binaryPath: () => undefined,
      cwd: () => undefined,
      ttlMs: () => 60_000,
      probe: () => Promise.resolve(CATALOG),
    }),
    transports: {
      // eslint-disable-next-line require-yield
      sdk: (request) => {
        sent.request = request
        return (async function* () {})()
      },
    },
  })
  return { instance, sent }
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'claude-cli',
    model: 'sonnet',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'oi' }], source: { kind: 'user' } })],
    ...extra,
  }
}

describe('catalogo exposto ao harness', () => {
  it('mostra a versao real do modelo no nome, nao um apelido "latest"', async () => {
    const models = await adapter().instance.listModels('claude-cli')
    expect(models.map((m) => m.name)).toEqual([
      'Opus (1M context) · claude-opus-5[1m]',
      'Sonnet · claude-sonnet-5',
      'Haiku · claude-haiku-4-5-20251001',
    ])
  })

  it('propaga a janela de contexto declarada pelo id', async () => {
    const resolved = await adapter().instance.resolveModel('claude-cli', 'opus[1m]')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })
})

describe('reasoning effort', () => {
  it('oferece os niveis que o modelo aceita', async () => {
    const resolved = await adapter().instance.resolveModel('claude-cli', 'sonnet')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high'])
    expect(resolved.reasoning?.efforts[0]).toMatchObject({ name: 'Low' })
  })

  it('nao oferece seletor para um modelo que nao aceita effort', async () => {
    // Haiku nao declara effort no CLI; anunciar niveis seria mentir.
    const resolved = await adapter().instance.resolveModel('claude-cli', 'haiku')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('materializa o default configurado', async () => {
    const resolved = await adapter({ defaultEffort: 'medium' })
      .instance.resolveModel('claude-cli', 'sonnet')
    expect(resolved.reasoning?.defaultEffort).toBe('medium')
  })

  it('descarta um default que o modelo nao oferece', async () => {
    // 'max' existe no opus mas nao no sonnet; materializa-lo faria toda
    // requisicao carregar um nivel que o modelo rejeita.
    const resolved = await adapter({ defaultEffort: 'max' })
      .instance.resolveModel('claude-cli', 'sonnet')
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
    expect(resolved.reasoning?.efforts).toHaveLength(3)
  })

  it('repassa o nivel escolhido ate a requisicao do transporte', async () => {
    const { instance, sent } = adapter()
    for await (const _ of instance.stream(
      request({ reasoningEffort: ReasoningEffortId('xhigh') }),
    )) { /* drena o stream para o transporte rodar */ }
    expect(sent.request?.effort).toBe('xhigh')
  })

  it('sem escolha, nao manda effort e deixa o default do proprio CLI valer', async () => {
    const { instance, sent } = adapter()
    for await (const _ of instance.stream(request())) { /* drena */ }
    expect(sent.request).toBeDefined()
    expect(sent.request?.effort).toBeUndefined()
  })

  it('recusa um nivel que nunca foi anunciado', () => {
    expect(() => adapter().instance.stream(request({ reasoningEffort: ReasoningEffortId('turbo') })))
      .toThrowError(expect.objectContaining({ code: 'UNKNOWN_REASONING_EFFORT' }) as never)
  })
})
