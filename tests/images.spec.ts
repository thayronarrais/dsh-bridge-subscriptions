import { describe, expect, it } from 'vitest'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ClaudeCliAdapter } from '../src/adapter.ts'
import type { ClaudeCliAdapterOptions, ClaudeCliConnection, TransportKind } from '../src/adapter.ts'
import { ModelCatalog } from '../src/catalog.ts'
import { buildSdkPrompt } from '../src/transport/sdk.ts'
import { streamViaSpawn } from '../src/transport/spawn.ts'
import { UNSUPPORTED_OPTION_CODE } from '../src/errors.ts'
import type { Transport, TransportImage, TransportRequest } from '../src/transport/types.ts'

function request(images?: readonly TransportImage[]): TransportRequest {
  return {
    prompt: 'documento',
    systemPrompt: 'sistema',
    tools: [],
    maxTurns: 1,
    idleTimeoutMs: 1000,
    ...images === undefined ? {} : { images },
  }
}

async function collect(prompt: string | AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage[]> {
  if (typeof prompt === 'string') throw new Error('esperava um iterable, veio string')
  const messages: SDKUserMessage[] = []
  for await (const message of prompt) messages.push(message)
  return messages
}

describe('buildSdkPrompt', () => {
  it('mantem o prompt como string quando a requisicao nao carrega imagem', () => {
    // O caminho texto nao pode mudar de modo por causa de uma feature que ele nao usa.
    expect(buildSdkPrompt(request())).toBe('documento')
  })

  it('emite uma unica mensagem de usuario com o documento e os blocos de imagem nativos', async () => {
    const prompt = buildSdkPrompt(request([{ mediaType: 'image/png', data: 'QUJD' }]))
    const messages = await collect(prompt)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message.content).toEqual([
      { type: 'text', text: 'documento' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ])
  })

  it('preserva a ordem das imagens', async () => {
    const prompt = buildSdkPrompt(request([
      { mediaType: 'image/png', data: 'primeira' },
      { mediaType: 'image/jpeg', data: 'segunda' },
    ]))
    const [message] = await collect(prompt)
    const content = message?.message.content
    expect(Array.isArray(content) ? content.length : 0).toBe(3)
    expect(Array.isArray(content) ? content[2] : undefined).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'segunda' },
    })
  })
})

describe('streamViaSpawn com imagem', () => {
  it('recusa a requisicao em vez de mandar o prompt sem os bytes', async () => {
    // `claude -p` recebe o prompt por stdin/argv: nao ha canal para bytes.
    const stream = streamViaSpawn(request([{ mediaType: 'image/png', data: 'QUJD' }]))
    await expect((async () => {
      for await (const _chunk of stream) break
    })()).rejects.toThrow(LlmError)
  })

  it('classifica a recusa como opcao nao suportada', async () => {
    const stream = streamViaSpawn(request([{ mediaType: 'image/png', data: 'QUJD' }]))
    const error = await (async () => {
      try {
        for await (const _chunk of stream) break
        return undefined
      } catch (thrown) {
        return thrown
      }
    })()
    expect((error as LlmError).code).toBe(UNSUPPORTED_OPTION_CODE)
  })
})

/** Captures the request the adapter hands the transport, without spawning a CLI. */
function adapter(options: {
  transport?: TransportKind
  readImage?: ClaudeCliAdapterOptions['readImage']
} = {}): { instance: ClaudeCliAdapter; sent: { request?: TransportRequest } } {
  const resolved: ClaudeCliConnection = {
    transport: options.transport ?? 'sdk',
    models: [],
    discoverModels: true,
    modelCacheTtlMs: 60_000,
    defaultContextWindow: 200_000,
    maxTurns: 2,
    streamIdleTimeoutMs: 60_000,
    maxPromptBytes: 2_000_000,
  }
  const sent: { request?: TransportRequest } = {}
  const capture: Transport = (captured) => {
    sent.request = captured
    return (async function* () {})()
  }
  const instance = new ClaudeCliAdapter({
    connection: () => resolved,
    catalog: new ModelCatalog({
      configured: () => [{ id: 'sonnet', name: 'Sonnet' }],
      discover: () => false,
      binaryPath: () => undefined,
      cwd: () => undefined,
      ttlMs: () => 60_000,
      probe: () => Promise.resolve([{ id: 'sonnet', name: 'Sonnet' }]),
    }),
    transports: { sdk: capture, spawn: capture },
    ...options.readImage === undefined ? {} : { readImage: options.readImage },
  })
  return { instance, sent }
}

const PNG_BYTES = new Uint8Array([1, 2, 3, 4])

function reader(): ClaudeCliAdapterOptions['readImage'] {
  return () => (ref) => Promise.resolve({ ref, data: PNG_BYTES })
}

function imageRequest(): GenerateOptions {
  return {
    provider: 'claude-cli',
    model: 'sonnet',
    messages: [createUserMessage({
      content: [
        { type: 'text', text: 'o que e isso?' },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('att-1'),
            mediaType: 'image/png',
            bytes: 4,
            width: 1,
            height: 1,
          },
        },
      ],
      source: { kind: 'user' },
    })],
  }
}

describe('declaracao de modalidade', () => {
  it('declara entrada de imagem quando o transport e sdk e ha leitor de anexos', async () => {
    const resolved = await adapter({ readImage: reader() }).instance.resolveModel('claude-cli', 'sonnet')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  it('continua text-only no transport spawn, que nao tem canal para bytes', async () => {
    const resolved = await adapter({ transport: 'spawn', readImage: reader() })
      .instance.resolveModel('claude-cli', 'sonnet')
    expect(resolved.inputModalities).toEqual(['text'])
  })

  it('continua text-only quando o servico de anexos nao esta montado', async () => {
    const resolved = await adapter().instance.resolveModel('claude-cli', 'sonnet')
    expect(resolved.inputModalities).toEqual(['text'])
  })

  it('declara a mesma capacidade em listModels e resolveModel', async () => {
    const [model] = await adapter({ readImage: reader() }).instance.listModels('claude-cli')
    expect(model?.inputModalities).toEqual(['text', 'image'])
  })
})

describe('resolucao dos bytes pelo adapter', () => {
  it('entrega ao transport a imagem do turno atual ja em base64', async () => {
    const { instance, sent } = adapter({ readImage: reader() })
    for await (const _chunk of instance.stream(imageRequest())) break
    expect(sent.request?.images).toEqual([
      { mediaType: 'image/png', data: Buffer.from(PNG_BYTES).toString('base64') },
    ])
  })

  it('nao carrega imagem alguma quando o leitor nao esta disponivel', async () => {
    const { instance, sent } = adapter()
    for await (const _chunk of instance.stream(imageRequest())) break
    expect(sent.request?.images ?? []).toEqual([])
  })
})
