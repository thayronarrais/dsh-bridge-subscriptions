import { describe, expect, it } from 'vitest'
import { classifyFailure, classifyThrown, toFailure } from '../src/errors.ts'

/** Fixed clock so the reset-delay arithmetic is deterministic. */
const NOW = 1_740_000_000_000

describe('classifyFailure', () => {
  it('reconhece o binario ausente antes de qualquer outra coisa', () => {
    const error = classifyFailure({ message: "spawn claude ENOENT", exitCode: null }, NOW)
    expect(error.code).toBe('CLI_NOT_FOUND')
    expect(error.message).toContain('binaryPath')
  })

  it('reconhece sessao nao autenticada', () => {
    const error = classifyFailure({ message: 'Please run /login to authenticate' }, NOW)
    expect(error.code).toBe('INVALID_CREDENTIAL')
  })

  it('reconhece limite de janela da assinatura como RATE_LIMIT', () => {
    const error = classifyFailure({ message: 'Claude AI usage limit reached' }, NOW)
    expect(error.code).toBe('RATE_LIMIT')
    expect(error.message).toContain('plan limit')
  })

  it('reconhece o tipo de erro cru da Anthropic', () => {
    // `_` e caractere de palavra: exigir \b depois de "limit" perderia isto.
    expect(classifyFailure({ message: '{"type":"rate_limit_error"}' }, NOW).code).toBe('RATE_LIMIT')
  })

  it('extrai o horario de reset e converte em atraso', () => {
    const resetIn = 90 * 60 * 1000
    const epochSeconds = Math.floor((NOW + resetIn) / 1000)
    const error = classifyFailure({ message: `Claude AI usage limit reached|${epochSeconds}` }, NOW)
    expect(error.code).toBe('RATE_LIMIT')
    expect(error.failure.providerRetryAfterMs).toBe(resetIn)
    expect(error.message).toContain('90 min')
  })

  it('ignora um reset ja vencido em vez de pedir atraso negativo', () => {
    const error = classifyFailure(
      { message: `usage limit reached|${Math.floor(NOW / 1000) - 60}` },
      NOW,
    )
    expect(error.failure.providerRetryAfterMs).toBeUndefined()
  })

  it('separa limite de plano de saldo esgotado', () => {
    // Ambos casariam com o classificador de quota do harness; a janela de
    // assinatura tem que vencer, porque a resolucao e oposta (esperar x pagar).
    expect(classifyFailure({ message: 'Claude AI usage limit reached' }, NOW).code).toBe('RATE_LIMIT')
    expect(classifyFailure({ message: 'insufficient quota for this account' }, NOW).code).toBe('QUOTA')
  })

  it('delega estouro de contexto ao classificador do harness', () => {
    const error = classifyFailure(
      { message: 'prompt is too long for this model context window' },
      NOW,
    )
    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('cai em TRANSPORT com o exit code quando nada mais casa', () => {
    const error = classifyFailure({ message: 'something odd happened', exitCode: 3 }, NOW)
    expect(error.code).toBe('TRANSPORT')
    expect(error.message).toContain('exit code 3')
  })

  it('le tambem o stderr, nao so a mensagem', () => {
    const error = classifyFailure({ message: 'failed', stderr: 'Invalid API key' }, NOW)
    expect(error.code).toBe('INVALID_CREDENTIAL')
  })
})

describe('classifyThrown', () => {
  it('devolve um LlmError intacto em vez de reclassificar', () => {
    const original = classifyFailure({ message: 'Claude AI usage limit reached' }, NOW)
    expect(classifyThrown(original)).toBe(original)
  })

  it('desenrola a cadeia de causas de um erro cru', () => {
    const error = classifyThrown(
      new Error('fetch failed', { cause: new Error('spawn claude ENOENT') }),
    )
    expect(error.code).toBe('CLI_NOT_FOUND')
  })
})

describe('toFailure', () => {
  it('expoe os fatos serializaveis que o finish carrega', () => {
    const failure = toFailure(classifyFailure({ message: 'Please run /login' }, NOW))
    expect(failure).toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(typeof failure.message).toBe('string')
  })
})
