import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_MODELS, ModelCatalog } from '../src/catalog.ts'
import type { ClaudeCliModel } from '../src/model.ts'

const DISCOVERED: ClaudeCliModel[] = [
  { id: 'sonnet', name: 'Sonnet · claude-sonnet-5', efforts: ['low', 'medium', 'high'] },
  { id: 'haiku', name: 'Haiku · claude-haiku-4-5-20251001' },
]

/** Build a catalog with every seam stubbed, so nothing spawns a CLI. */
function catalog(overrides: {
  configured?: ClaudeCliModel[]
  discover?: boolean
  ttlMs?: number
  probe?: () => Promise<ClaudeCliModel[]>
  now?: () => number
} = {}) {
  const probe = overrides.probe ?? (() => Promise.resolve(DISCOVERED))
  const calls = { count: 0 }
  return {
    calls,
    instance: new ModelCatalog({
      configured: () => overrides.configured ?? [],
      discover: () => overrides.discover ?? true,
      binaryPath: () => undefined,
      cwd: () => undefined,
      ttlMs: () => overrides.ttlMs ?? 60_000,
      now: overrides.now ?? (() => 1_000),
      probe: async (...args) => {
        calls.count++
        return probe(...(args as [])) as Promise<ClaudeCliModel[]>
      },
    }),
  }
}

describe('ModelCatalog', () => {
  it('devolve o que o CLI reportou', async () => {
    const { instance } = catalog()
    expect(await instance.list()).toEqual(DISCOVERED)
  })

  it('cacheia: duas consultas seguidas sondam o CLI uma vez so', async () => {
    const { instance, calls } = catalog()
    await instance.list()
    await instance.list()
    expect(calls.count).toBe(1)
  })

  it('compartilha uma sonda em voo entre chamadas concorrentes', async () => {
    // listModels e resolveModel sao chamados juntos; cada sonda sobe um processo.
    const { instance, calls } = catalog()
    await Promise.all([instance.list(), instance.list(), instance.list()])
    expect(calls.count).toBe(1)
  })

  it('re-sonda depois que o TTL expira', async () => {
    let clock = 1_000
    const { instance, calls } = catalog({ ttlMs: 500, now: () => clock })
    await instance.list()
    clock += 499
    await instance.list()
    expect(calls.count).toBe(1)
    clock += 2
    await instance.list()
    expect(calls.count).toBe(2)
  })

  it('invalidate() forca uma nova sonda', async () => {
    const { instance, calls } = catalog()
    await instance.list()
    instance.invalidate()
    await instance.list()
    expect(calls.count).toBe(2)
  })

  it('um catalogo fixado na config vence e nem sonda', async () => {
    const configured = [{ id: 'pinned', name: 'Pinned' }]
    const { instance, calls } = catalog({ configured })
    expect(await instance.list()).toEqual(configured)
    expect(calls.count).toBe(0)
  })

  it('discoverModels: false serve o fallback sem sondar', async () => {
    const { instance, calls } = catalog({ discover: false })
    expect(await instance.list()).toEqual(FALLBACK_MODELS)
    expect(calls.count).toBe(0)
  })

  it('falha de descoberta cai no fallback em vez de derrubar a rota', async () => {
    const warn = vi.fn()
    const instance = new ModelCatalog({
      configured: () => [],
      discover: () => true,
      binaryPath: () => undefined,
      cwd: () => undefined,
      ttlMs: () => 60_000,
      logger: { warn, debug: vi.fn() },
      probe: () => Promise.reject(new Error('not logged in')),
    })
    expect(await instance.list()).toEqual(FALLBACK_MODELS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not logged in'))
  })

  it('mantem o ultimo catalogo bom quando uma re-sonda falha', async () => {
    let fail = false
    let clock = 1_000
    const { instance } = catalog({
      ttlMs: 10,
      now: () => clock,
      probe: () => fail ? Promise.reject(new Error('offline')) : Promise.resolve(DISCOVERED),
    })
    await instance.list()
    fail = true
    clock += 100
    // Degradar para os apelidos genericos apagaria versoes que ja sabemos.
    expect(await instance.list()).toEqual(DISCOVERED)
  })

  it('lista vazia do CLI nao apaga o catalogo', async () => {
    const { instance } = catalog({ probe: () => Promise.resolve([]) })
    expect(await instance.list()).toEqual(FALLBACK_MODELS)
  })
})
