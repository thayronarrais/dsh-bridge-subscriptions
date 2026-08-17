/**
 * Live tests against the real, locally authenticated Claude Code CLI.
 *
 * Skipped unless `DSH_CLAUDE_LIVE=1`, because each run consumes subscription
 * usage and needs `claude` installed and signed in:
 *
 *   $env:DSH_CLAUDE_LIVE = '1'; npx vitest run tests/live.spec.ts
 *
 * These are the only tests that can catch a drift between this adapter's
 * containment options and the installed CLI — in particular whether harness
 * tools still reach the model directly instead of being deferred behind Claude
 * Code's own ToolSearch.
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter } from '../src/adapter.ts'
import type { ClaudeCliConnection } from '../src/adapter.ts'
import { EFFORT_LEVELS } from '../src/effort.ts'

const LIVE = process.env['DSH_CLAUDE_LIVE'] === '1'

const CONNECTION: ClaudeCliConnection = {
  transport: 'sdk',
  // Pinned so these tests never depend on what the CLI happens to advertise.
  models: [{ id: 'sonnet', name: 'Claude Sonnet', contextWindow: 200_000, efforts: [...EFFORT_LEVELS] }],
  discoverModels: false,
  modelCacheTtlMs: 0,
  defaultContextWindow: 200_000,
  maxTurns: 2,
  streamIdleTimeoutMs: 120_000,
  maxPromptBytes: 2_000_000,
}

const WEATHER_TOOL: ToolSchema = {
  name: 'get_weather',
  description: 'Return the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city'],
    additionalProperties: false,
  },
}

function adapter(): ClaudeCliAdapter {
  return new ClaudeCliAdapter({ connection: () => CONNECTION })
}

function request(text: string, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'claude-cli',
    model: 'sonnet',
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    ...extra,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe.skipIf(!LIVE)('live: Claude Code CLI', () => {
  it('faz streaming de texto e termina em stop', { timeout: 180_000 }, async () => {
    const chunks = await collect(adapter().stream(
      request('Reply with exactly these three words: harness bridge works'),
    ))

    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    expect(text.toLowerCase()).toContain('harness bridge works')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    const usage = chunks.find((c) => c.type === 'usage')
    expect(usage).toBeDefined()
    expect((usage as Extract<StreamChunk, { type: 'usage' }>).usage.outputTokens).toBeGreaterThan(0)
  })

  it('entrega a tool call do harness sem passar pelo ToolSearch', { timeout: 180_000 }, async () => {
    const chunks = await collect(adapter().stream(
      request('What is the weather in Recife? Use the tool.', { tools: [WEATHER_TOOL] }),
    ))

    const toolBlocks = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end')
      .map((c) => c.block)
      .filter((block) => block.type === 'tool-call')
    expect(toolBlocks).toHaveLength(1)

    const call = toolBlocks[0] as { name: string; arguments: string }
    // Namespace stripped, and — critically — it is our tool rather than
    // Claude Code's ToolSearch standing in for it.
    expect(call.name).toBe('get_weather')
    expect(JSON.parse(call.arguments)).toMatchObject({ city: expect.stringMatching(/recife/i) })

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('encerra prontamente quando o caller aborta no meio', { timeout: 180_000 }, async () => {
    const controller = new AbortController()
    const started = Date.now()
    const stream = adapter().stream(
      request('Count slowly from 1 to 500, one number per line.', { signal: controller.signal }),
    )

    const chunks: StreamChunk[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
      if (chunk.type === 'block-start') controller.abort()
    }

    // Nao da para exigir `aborted` aqui: se o provider ja tinha entregue a
    // resposta inteira antes do abort chegar, `stop` e o desfecho correto, e o
    // teste ficaria intermitente ao fingir o contrario. O que e determinístico
    // e o que importa em producao: o stream termina, termina uma vez so, e nao
    // fica pendurado. A garantia estrita de `aborted` esta no teste abaixo,
    // que aborta antes da chamada comecar.
    const finishes = chunks.filter((chunk) => chunk.type === 'finish')
    expect(finishes).toHaveLength(1)
    expect(chunks.at(-1)).toBe(finishes[0])
    expect((finishes[0] as Extract<StreamChunk, { type: 'finish' }>).reason.kind)
      .toMatch(/^(aborted|stop)$/)
    expect(Date.now() - started).toBeLessThan(60_000)
  })

  it('honra um AbortSignal ja disparado antes da chamada', { timeout: 180_000 }, async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter().stream(
      request('hello', { signal: AbortSignal.abort() }),
    )) {
      chunks.push(chunk)
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('aceita cada nivel de effort que anunciamos', { timeout: 240_000 }, async () => {
    // Prova que `--effort` chega ao CLI sem ser rejeitado. A profundidade do
    // raciocinio em si nao da para afirmar sem virar teste intermitente.
    for (const level of ['low', 'max'] as const) {
      const chunks = await collect(adapter().stream(
        request('Reply with the single word: ok', { reasoningEffort: ReasoningEffortId(level) }),
      ))
      expect(chunks.at(-1), `effort ${level}`)
        .toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    }
  })

  it('recusa stop sequences em vez de ignora-las em silencio', () => {
    expect(() => adapter().stream(request('hi', { stop: ['\n\n'] })))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }) as never)
  })
})
