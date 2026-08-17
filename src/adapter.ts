/**
 * The `LlmAdapter` implementation: a harness provider route whose backend is
 * the locally installed, already-authenticated Claude Code CLI.
 *
 * @module dsh-claude-cli/adapter
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ModelCatalog } from './catalog.ts'
import { EFFORT_DISPLAY, isEffortLevel } from './effort.ts'
import type { EffortLevel } from './effort.ts'
import type { ClaudeCliModel } from './model.ts'
import { UNKNOWN_REASONING_EFFORT_CODE, UNSUPPORTED_OPTION_CODE } from './errors.ts'
import { buildSystemPrompt, renderConversation } from './translate/request.ts'
import { streamViaSdk } from './transport/sdk.ts'
import { streamViaSpawn } from './transport/spawn.ts'
import type { Transport, TransportLogger, TransportRequest } from './transport/types.ts'

export type { ClaudeCliModel } from './model.ts'

/** Which transport carries the call. */
export type TransportKind = 'sdk' | 'spawn'

/** Connection facts resolved once per request, so settings changes take effect immediately. */
export interface ClaudeCliConnection {
  transport: TransportKind
  /** Pinned catalog; empty means ask the CLI. */
  models: readonly ClaudeCliModel[]
  /** Whether to ask the CLI which models it can reach. */
  discoverModels: boolean
  /** How long a discovered catalog stays fresh. */
  modelCacheTtlMs: number
  defaultContextWindow: number
  /** Effort applied when the caller selects none and the model supports effort. */
  defaultEffort?: EffortLevel
  maxTurns: number
  streamIdleTimeoutMs: number
  maxPromptBytes: number
  binaryPath?: string
  cwd?: string
  /**
   * Provider-owned retry policy. Retrying is the `llm-retry` plugin's job, not
   * this adapter's — all this route does is declare the policy it wants, so
   * subscription window limits are not hammered with blind retries.
   */
  retryPolicy?: ResolvedRetryPolicy
}

/** Everything the adapter needs from its owning plugin. */
export interface ClaudeCliAdapterOptions {
  /** Re-read on every request; never captured at construction. */
  connection: () => ClaudeCliConnection
  logger?: TransportLogger
  /** Injected by tests to stand in for the real CLI probe. */
  catalog?: ModelCatalog
  /** Injected by tests to observe the assembled request without spawning a CLI. */
  transports?: Partial<Record<TransportKind, Transport>>
}

const TRANSPORTS: Record<TransportKind, Transport> = {
  sdk: streamViaSdk,
  spawn: streamViaSpawn,
}

/**
 * Bridges the harness request vocabulary onto the Claude Code CLI.
 *
 * `stream()` is the only method the base class requires; the rest are
 * overridden so model pickers and the retry policy have real metadata to work
 * with instead of the identity defaults.
 */
export class ClaudeCliAdapter extends LlmAdapter {
  readonly #options: ClaudeCliAdapterOptions
  readonly #catalog: ModelCatalog
  /** Guards the one-time warning about knobs the CLI does not expose. */
  #warnedUnsupported = false

  constructor(options: ClaudeCliAdapterOptions) {
    super()
    this.#options = options
    this.#catalog = options.catalog ?? new ModelCatalog({
      configured: () => this.#options.connection().models,
      discover: () => this.#options.connection().discoverModels,
      binaryPath: () => this.#options.connection().binaryPath,
      cwd: () => this.#options.connection().cwd,
      ttlMs: () => this.#options.connection().modelCacheTtlMs,
      ...options.logger === undefined ? {} : { logger: options.logger },
    })
  }

  /** Drop the discovered catalog so the next query re-probes the CLI. */
  invalidateCatalog(): void {
    this.#catalog.invalidate()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code (subscription)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.#options.connection().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.#catalog.list()
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
      // Explicit negative capability: the CLI takes a text prompt, and the
      // adapter has nowhere to put image bytes.
      inputModalities: ['text'] as const,
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.#options.connection()
    const models = await this.#catalog.list(signal)
    // The catalog is advisory: Claude Code resolves aliases and full model ids
    // itself, so an unlisted id must not become a request rejection.
    const known = models.find((candidate) => candidate.id === model)
    const reasoning = this.#reasoningFor(known?.efforts, connection.defaultEffort)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...known?.description === undefined ? {} : { description: known.description },
      inputModalities: ['text'] as const,
      context: { contextWindow: known?.contextWindow ?? connection.defaultContextWindow },
      ...known?.maxTokens === undefined ? {} : { defaultMaxTokens: known.maxTokens },
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  /**
   * Describe the effort levels one model offers.
   *
   * Returning nothing is meaningful: the harness only shows an effort picker
   * for a model whose `reasoning` metadata lists levels, so a model the CLI
   * says takes no effort parameter correctly gets no picker.
   */
  #reasoningFor(
    efforts: readonly EffortLevel[] | undefined,
    configuredDefault: EffortLevel | undefined,
  ): LlmModelReasoningInfo | undefined {
    if (efforts === undefined || efforts.length === 0) return undefined
    // A default the model does not offer would be materialized into every
    // request and rejected; drop it rather than send it.
    const usableDefault = configuredDefault !== undefined && efforts.includes(configuredDefault)
      ? configuredDefault
      : undefined
    return {
      efforts: efforts.map((level) => ({
        id: ReasoningEffortId(level),
        name: EFFORT_DISPLAY[level].name,
        description: EFFORT_DISPLAY[level].description,
      })),
      ...usableDefault === undefined ? {} : { defaultEffort: ReasoningEffortId(usableDefault) },
    }
  }

  /**
   * Stream one model call.
   * @param options - the fully-assembled harness request.
   * @returns the chunk stream, terminating in exactly one `finish`.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.#options.connection()
    this.#rejectUnsupported(options)

    const { prompt, truncated } = renderConversation(options.messages, {
      maxPromptBytes: connection.maxPromptBytes,
    })
    if (truncated) {
      this.#options.logger?.warn(
        'claude-cli: conversation exceeded maxPromptBytes; the oldest turns were dropped',
      )
    }

    const tools = options.tools ?? []
    const effort = this.#resolveEffort(options)
    const request: TransportRequest = {
      prompt,
      systemPrompt: buildSystemPrompt(options.system, tools.length > 0),
      tools,
      maxTurns: connection.maxTurns,
      idleTimeoutMs: connection.streamIdleTimeoutMs,
      model: options.model,
      ...effort === undefined ? {} : { effort },
      ...options.signal === undefined ? {} : { signal: options.signal },
      ...connection.binaryPath === undefined ? {} : { binaryPath: connection.binaryPath },
      ...connection.cwd === undefined ? {} : { cwd: connection.cwd },
      ...this.#options.logger === undefined ? {} : { logger: this.#options.logger },
    }

    const transport = this.#options.transports?.[connection.transport]
      ?? TRANSPORTS[connection.transport]
    return transport(request)
  }

  /**
   * Decide which effort level, if any, this call sends.
   *
   * The harness only offers levels this adapter advertised through
   * `resolveModel`, so an unrecognized one means something upstream invented a
   * value — refused rather than forwarded, because the CLI would either reject
   * it or, worse, quietly ignore it.
   *
   * @param options - the harness request.
   * @returns the level to send, or `undefined` to leave the CLI's own default.
   */
  #resolveEffort(options: GenerateOptions): EffortLevel | undefined {
    const requested = options.reasoningEffort
    if (requested === undefined) return undefined
    if (!isEffortLevel(requested)) {
      throw new LlmError(
        `claude-cli: unknown reasoning effort "${requested}"; expected one of`
        + ` ${Object.keys(EFFORT_DISPLAY).join(', ')}`,
        UNKNOWN_REASONING_EFFORT_CODE,
      )
    }
    return requested
  }

  /**
   * Refuse request fields the CLI cannot honor.
   *
   * The adapter contract says to fail rather than silently ignore an
   * unsupported field. `stop` is refused outright: dropping it changes what the
   * model is allowed to produce, and the caller would never know. `temperature`
   * and `maxTokens` are advisory shaping hints with no CLI equivalent at all,
   * so refusing them would make the provider unusable for no safety gain —
   * they get one warning per adapter instance instead.
   */
  #rejectUnsupported(options: GenerateOptions): void {
    if (options.stop !== undefined && options.stop.length > 0) {
      throw new LlmError(
        'claude-cli: stop sequences are not supported — the Claude Code CLI exposes no stop-sequence'
        + ' option, and honoring the request is impossible rather than merely inconvenient',
        UNSUPPORTED_OPTION_CODE,
      )
    }
    if (this.#warnedUnsupported) return
    const ignored = [
      options.temperature === undefined ? undefined : 'temperature',
      options.maxTokens === undefined ? undefined : 'maxTokens',
    ].filter((name): name is string => name !== undefined)
    if (ignored.length === 0) return
    this.#warnedUnsupported = true
    this.#options.logger?.warn(
      `claude-cli: ignoring ${ignored.join(' and ')} — the Claude Code CLI exposes no such option`,
    )
  }
}
