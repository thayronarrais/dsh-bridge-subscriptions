/**
 * Integration test against the real harness runtime: mount `LlmRuntime` and
 * this plugin on a real Cordis context and drive the provider through
 * `ctx.llm.stream()` — the same path the agent loop uses — rather than calling
 * the adapter directly.
 *
 * This is what proves the plugin is wired correctly: route registration,
 * configurable-provider directory, model resolution, and `BlockAssembler`
 * accepting the chunk stream. The generation itself is live-gated, since it
 * consumes subscription usage.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as BridgePlugin from '../src/index.ts'
import type { Config } from '../src/index.ts'

const LIVE = process.env['DSH_CLAUDE_LIVE'] === '1'
const PROVIDER = 'claude-cli'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Mount the runtime and this plugin, and wait for both fibers to settle. */
async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  // `ctx.plugin()` returns an awaitable fiber that settles once loading is done.
  await ctx.plugin(LlmRuntime)
  // `inject: ['llm']` means this one only starts once the runtime is up, so
  // awaiting its fiber is also what guarantees the route is registered.
  await ctx.plugin(BridgePlugin, config)
  return ctx
}

/** Whether a provider route is currently serving requests. */
function routeLive(ctx: Context, provider: string): boolean {
  return ctx.llm.listProviders().some((entry) => entry.id === provider)
}

describe('plugin composition', () => {
  it('registra a rota claude-cli no runtime', async () => {
    const ctx = await mount()
    expect(ctx.llm.listProviders()).toContainEqual({
      id: PROVIDER,
      name: 'Claude Code (subscription)',
    })
  })

  it('aparece no diretorio de providers configuraveis, para a pagina de Models', async () => {
    const ctx = await mount()
    expect(ctx.llm.listConfigurableProviders()).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER,
        displayName: 'Claude Code (subscription)',
        settingsPath: ['claude'],
      }),
    )
  })

  it('serve o catalogo embutido, text-only, quando a descoberta esta desligada', async () => {
    const ctx = await mount({ claude: { discoverModels: false } })
    const models = await ctx.llm.listModels(PROVIDER)
    expect(models.map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku'])
    expect(models.every((m) => m.inputModalities?.includes('image') !== true)).toBe(true)
  })

  it('declara entrada de imagem quando o servico de anexos esta montado', async () => {
    // O inject de `attachments` e opcional: e a presenca dele, em runtime, que
    // separa uma rota text-only de uma que sabe ler imagem.
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    ctx.provide('attachments', {
      readImage: () => Promise.reject(new Error('os bytes nao sao lidos neste teste')),
    } as never)
    await ctx.plugin(BridgePlugin, { claude: { discoverModels: false } })
    const models = await ctx.llm.listModels(PROVIDER)
    expect(models.every((m) => m.inputModalities?.includes('image') === true)).toBe(true)
  })

  it('respeita um catalogo customizado vindo da config', async () => {
    const ctx = await mount({
      claude: { models: [{ id: 'sonnet', name: 'Only Sonnet', contextWindow: 123_456 }] },
    })
    const resolved = await ctx.llm.resolveModelInfo(PROVIDER, 'sonnet')
    expect(resolved).toMatchObject({ id: 'sonnet', name: 'Only Sonnet' })
    expect(resolved.context?.contextWindow).toBe(123_456)
  })

  it('resolve um modelo fora do catalogo usando o contexto default', async () => {
    // O catalogo e consultivo: o Claude Code resolve aliases sozinho, entao um
    // id nao listado nao pode virar rejeicao de request.
    const ctx = await mount({ claude: { discoverModels: false, defaultContextWindow: 111_000 } })
    const resolved = await ctx.llm.resolveModelInfo(PROVIDER, 'claude-opus-4-5-20251101')
    expect(resolved.context?.contextWindow).toBe(111_000)
  })

  it('recusa config invalida no load em vez de servir algo quebrado', () => {
    expect(() => BridgePlugin.resolveClaudeOptions({ maxTurns: 0 }))
      .toThrowError(/maxTurns/)
    expect(() => BridgePlugin.resolveClaudeOptions({ models: [{ id: 'a' }, { id: 'a' }] }))
      .toThrowError(/duplicate/)
  })
})

describe('liga/desliga por bridge', () => {
  it('vem ligado por padrao', async () => {
    const ctx = await mount()
    expect(routeLive(ctx, PROVIDER)).toBe(true)
  })

  it('enabled: false retira a rota do registro', async () => {
    const ctx = await mount({ claude: { enabled: false } })
    expect(routeLive(ctx, PROVIDER)).toBe(false)
  })

  it('desligado, continua listado como provider configuravel', async () => {
    // E isso que mantem a linha na pagina de Models para religar depois; se
    // sumisse, so daria para voltar reinstalando o plugin.
    const ctx = await mount({ claude: { enabled: false } })
    expect(ctx.llm.listConfigurableProviders().map((entry) => entry.provider))
      .toContain(PROVIDER)
  })

  it('desligado, uma requisicao para a rota falha em vez de ser atendida', async () => {
    const ctx = await mount({ claude: { enabled: false } })
    await expect(ctx.llm.listModels(PROVIDER)).rejects.toThrow()
  })
})

describe.skipIf(!LIVE)('live: descoberta de modelos pelo CLI', () => {
  it('publica ids versionados de verdade, nao apelidos "latest"', { timeout: 120_000 }, async () => {
    const ctx = await mount()
    const models = await ctx.llm.listModels(PROVIDER)

    expect(models.length).toBeGreaterThan(0)
    // O nome carrega o id de wire resolvido, que e a unica forma de o usuario
    // ver qual versao esta usando: o picker do harness mostra so o nome.
    const versioned = models.filter((model) => /claude-[a-z]+-\d/.test(model.name))
    expect(versioned.length).toBeGreaterThan(0)
  })

  it('descobre o suporte a effort por modelo, sem chutar', { timeout: 120_000 }, async () => {
    const ctx = await mount()
    const models = await ctx.llm.listModels(PROVIDER)
    const resolved = await Promise.all(
      models.map((model) => ctx.llm.resolveModelInfo(PROVIDER, model.id)),
    )

    // Pelo menos um modelo oferece effort...
    const withEffort = resolved.filter((model) => model.reasoning !== undefined)
    expect(withEffort.length).toBeGreaterThan(0)
    for (const model of withEffort) {
      expect(model.reasoning?.efforts.length).toBeGreaterThan(0)
      for (const effort of model.reasoning?.efforts ?? []) {
        expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(effort.id)
      }
    }
    // ...e o Haiku, que o CLI reporta sem effort, nao ganha seletor.
    const haiku = resolved.find((model) => model.id === 'haiku')
    if (haiku !== undefined) expect(haiku.reasoning).toBeUndefined()
  })
})

describe.skipIf(!LIVE)('live: geracao pelo caminho de producao', () => {
  it('monta uma mensagem completa via ctx.llm.stream + BlockAssembler', { timeout: 180_000 }, async () => {
    const ctx = await mount({ claude: { models: [{ id: 'sonnet', contextWindow: 200_000 }] } })
    const request: GenerateOptions = {
      provider: PROVIDER,
      model: 'sonnet',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly: routed through the harness' }],
        source: { kind: 'user' },
      })],
    }

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(request) as AsyncIterable<StreamChunk>) {
      assembler.push(chunk)
    }

    const message = assembler.message({ kind: 'model', provider: PROVIDER, model: 'sonnet' })
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
    expect(text.toLowerCase()).toContain('routed through the harness')
    expect(assembler.finish).toMatchObject({ kind: 'stop' })
    expect(assembler.usage?.outputTokens).toBeGreaterThan(0)
  })
})
