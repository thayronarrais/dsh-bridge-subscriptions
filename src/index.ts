/**
 * One plugin hosting every subscription bridge: CLIs you already pay a flat
 * subscription for, exposed to the harness as ordinary provider routes.
 *
 * Today that is `claude-cli`, backed by the Claude Code CLI. `codex-cli` is
 * planned and slots in beside it — the shape below exists so adding one is a
 * new entry in {@link BRIDGES} plus its config section, not a second plugin.
 *
 * Each bridge can be switched off on its own. A disabled route is withdrawn
 * from the registry but stays declared as a configurable provider, so it keeps
 * its row in **Settings → Models** and can be switched back on without
 * reinstalling anything. Connection facts resolve per request, so everything
 * except the retry policy reaches the next call without a restart.
 *
 * @module dsh-bridge-subscriptions
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ClaudeCliAdapter } from './adapter.ts'
import type { ClaudeCliConnection, TransportKind } from './adapter.ts'
import { EFFORT_LEVELS } from './effort.ts'
import type { EffortLevel } from './effort.ts'
import type { ClaudeCliModel } from './model.ts'
import { DEFAULT_MAX_PROMPT_BYTES } from './translate/request.ts'

export { ClaudeCliAdapter } from './adapter.ts'
export type { ClaudeCliConnection, TransportKind } from './adapter.ts'
export { FALLBACK_MODELS, ModelCatalog } from './catalog.ts'
export { discoverModels } from './discovery.ts'
export type { DiscoveredModel } from './discovery.ts'
export { EFFORT_LEVELS, isEffortLevel } from './effort.ts'
export type { EffortLevel } from './effort.ts'
export { classifyFailure } from './errors.ts'
export type { ClaudeCliModel } from './model.ts'
export { StreamTranslator } from './translate/events.ts'

export const name = 'bridge-subscriptions'
export const inject = ['llm']

const NS = settingsNamespace('bridge-subscriptions')

/** Provider route backed by the Claude Code CLI. */
export const CLAUDE_PROVIDER = 'claude-cli'

/** `setTimeout` saturates past this, so a larger idle budget would never fire. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TURNS = 2
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MODEL_CACHE_TTL_MS = 600_000

/**
 * Settings for the Claude Code bridge.
 *
 * Every field is optional: an empty section runs the discovered catalog through
 * the SDK transport, which is the configuration most setups want.
 */
export interface ClaudeBridgeConfig {
  /**
   * Whether this bridge serves requests. Turning it off withdraws the route
   * while keeping the provider listed, so it can be turned back on later.
   */
  enabled?: boolean
  /**
   * How the CLI is driven. `sdk` uses the official Agent SDK and is the only
   * transport that supports tool calling. `spawn` shells out to `claude -p`
   * and is a text-only escape hatch.
   */
  transport?: TransportKind
  /** Override for the `claude` executable; resolved on PATH when omitted. */
  binaryPath?: string
  /** Working directory for the provider process; defaults to the harness process cwd. */
  cwd?: string
  /**
   * Ask the CLI which models it can reach, including their real versions and
   * per-model effort support. Turn this off only to pin `models` by hand.
   */
  discoverModels?: boolean
  /**
   * Pinned catalog. A non-empty list overrides discovery entirely, so the ids,
   * names, and effort levels here are the whole truth for this route.
   */
  models?: ClaudeCliModel[]
  /** How long a discovered catalog stays fresh before the CLI is asked again. */
  modelCacheTtlMs?: number
  /** Context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /**
   * Reasoning effort applied when the caller picks none. Ignored for a model
   * that does not offer that level.
   */
  defaultEffort?: EffortLevel
  /**
   * Hard ceiling on Claude Code's own turns. The harness owns the real agent
   * loop, so this only needs enough room for one assistant turn plus its tool
   * call; raising it lets a nested loop start competing with the harness one.
   */
  maxTurns?: number
  /** Maximum provider silence while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Byte ceiling for the rendered conversation; the oldest turns are dropped first. */
  maxPromptBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

/** Plugin config: one section per bridge. */
export interface Config {
  /** The Claude Code bridge. */
  claude?: ClaudeBridgeConfig
}

const effortSchema = z.union([...EFFORT_LEVELS] as [EffortLevel, ...EffortLevel[]])

const modelSchema: z<ClaudeCliModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  efforts: z.array(effortSchema),
})

const claudeSchema: z<ClaudeBridgeConfig> = z.object({
  enabled: z.boolean().default(true),
  transport: z.union(['sdk', 'spawn'] as const).default('sdk'),
  binaryPath: z.string(),
  cwd: z.string(),
  discoverModels: z.boolean().default(true),
  models: z.array(modelSchema).default([]),
  modelCacheTtlMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MODEL_CACHE_TTL_MS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultEffort: effortSchema,
  maxTurns: z.number().step(1).min(1).max(16).default(DEFAULT_MAX_TURNS),
  streamIdleTimeoutMs: z.number().min(1000).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxPromptBytes: z.number().step(1).min(1024).default(DEFAULT_MAX_PROMPT_BYTES),
  retryPolicy: RetryPolicySchema,
})

export const Config: z<Config> = z.object({
  claude: claudeSchema,
})

/** Connection facts plus the one fact captured at registration. */
interface ResolvedClaudeOptions extends ClaudeCliConnection {
  enabled: boolean
  retryPolicy: ResolvedRetryPolicy
}

/** Validate and detach a pinned model catalog. An empty list means "ask the CLI". */
function resolveModels(models: readonly ClaudeCliModel[] | undefined): ClaudeCliModel[] {
  const seen = new Set<string>()
  return (models ?? []).map((model) => {
    if (model.id.length === 0) {
      throw new Error('bridge-subscriptions: claude.models ids must be non-empty')
    }
    if (seen.has(model.id)) {
      throw new Error(`bridge-subscriptions: duplicate claude.models entry "${model.id}"`)
    }
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.efforts === undefined ? {} : { efforts: [...model.efforts] },
    }
  })
}

/**
 * The one explicit step from raw config to validated connection facts.
 *
 * Programmatic construction can bypass schemastery normalization, so every
 * default and bound is re-judged here — at load for the composition entry (fail
 * loud) and at first use for each settings snapshot.
 *
 * @param config - the raw `claude` section, or `undefined` when absent.
 * @returns validated connection facts, the enabled flag, and the retry policy.
 */
export function resolveClaudeOptions(config: ClaudeBridgeConfig = {}): ResolvedClaudeOptions {
  const idle = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(idle) || idle <= 0 || idle > MAX_TIMER_DELAY_MS) {
    throw new Error(
      'bridge-subscriptions: claude.streamIdleTimeoutMs must be a positive finite number'
      + ` no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error('bridge-subscriptions: claude.maxTurns must be a positive integer')
  }
  const contextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('bridge-subscriptions: claude.defaultContextWindow must be a positive integer')
  }
  return {
    enabled: config.enabled ?? true,
    transport: config.transport ?? 'sdk',
    models: resolveModels(config.models),
    discoverModels: config.discoverModels ?? true,
    modelCacheTtlMs: config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS,
    defaultContextWindow: contextWindow,
    maxTurns,
    streamIdleTimeoutMs: idle,
    maxPromptBytes: config.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES,
    ...config.defaultEffort === undefined ? {} : { defaultEffort: config.defaultEffort },
    ...config.binaryPath === undefined ? {} : { binaryPath: config.binaryPath },
    ...config.cwd === undefined ? {} : { cwd: config.cwd },
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'bridge-subscriptions: claude.retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: ClaudeBridgeConfig | undefined
  let lastGood: ResolvedClaudeOptions | undefined

  const claude = (): ResolvedClaudeOptions => {
    const raw = current().claude ?? {}
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveClaudeOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound: keep
      // serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error(
        'bridge-subscriptions: keeping the last good claude configuration after an invalid settings section',
      )
      ctx.logger.error(error)
      return lastGood
    }
  }
  claude()

  const adapter = new ClaudeCliAdapter({
    connection: claude,
    logger: {
      warn: (message) => ctx.logger.warn(message),
      debug: (message) => ctx.logger.debug(message),
    },
  })

  // Declared unconditionally, so a disabled bridge still has a row in the
  // Models page to switch back on. Declaring a provider is independent of
  // whether it currently serves requests.
  ctx.llm.registerConfigurableProviders([{
    provider: CLAUDE_PROVIDER,
    displayName: 'Claude Code (subscription)',
    settingsNs: NS,
    settingsPath: ['claude'],
  }])

  // An empty initial registration is rejected, so the route is claimed first
  // and withdrawn immediately when the bridge starts disabled. `apply` runs
  // synchronously, so no request can observe the intervening state.
  const registration = ctx.llm.registerAdapter([CLAUDE_PROVIDER], adapter)

  let registeredEnabled = true
  let registeredPolicy = claude().retryPolicy
  let catalogInputs = catalogFingerprint(claude())

  /** Bring the registry in line with the current settings snapshot. */
  const syncRegistration = (): void => {
    const next = claude()

    // Discovery is cached, so a changed executable, working directory, or
    // pinned catalog has to drop it — otherwise the picker would keep showing
    // models read from the previous CLI.
    const fingerprint = catalogFingerprint(next)
    if (!deepEqualJson(fingerprint, catalogInputs)) {
      catalogInputs = fingerprint
      adapter.invalidateCatalog()
    }

    // The retry policy is captured at registration, so it is the one fact
    // per-request resolution cannot refresh; re-registering the same route in
    // one synchronous section is what picks it up. Disposing and registering
    // again would publish an empty route set in between, and anything watching
    // would see the provider vanish and come back.
    const policyChanged = !deepEqualJson(next.retryPolicy, registeredPolicy)
    if (next.enabled === registeredEnabled && !policyChanged) return

    registration.replace(next.enabled ? [CLAUDE_PROVIDER] : [])
    if (next.enabled !== registeredEnabled) {
      ctx.logger.info(
        `bridge-subscriptions: ${CLAUDE_PROVIDER} ${next.enabled ? 'enabled' : 'disabled'}`,
      )
    }
    registeredEnabled = next.enabled
    registeredPolicy = next.retryPolicy
  }

  syncRegistration()

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: syncRegistration,
  })
}

/** The config facts a cached model catalog depends on. */
function catalogFingerprint(options: ResolvedClaudeOptions): unknown {
  return {
    binaryPath: options.binaryPath,
    cwd: options.cwd,
    discoverModels: options.discoverModels,
    models: options.models,
  }
}
