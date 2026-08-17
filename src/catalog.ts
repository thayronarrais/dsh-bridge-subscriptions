/**
 * The model catalog this route advertises: whatever the CLI reports, unless the
 * user pinned a list in configuration.
 *
 * Discovery spawns a CLI process, so the result is cached. A failure is not
 * fatal: an offline or signed-out CLI falls back to the static catalog so the
 * provider still routes, and the next call retries.
 *
 * @module dsh-claude-cli/catalog
 */

import { discoverModels } from './discovery.ts'
import type { ClaudeCliModel } from './model.ts'
import type { TransportLogger } from './transport/types.ts'

/**
 * Last-resort catalog for when discovery fails. Aliases only, because a pinned
 * version is the one thing guaranteed to go stale. Effort support is left off
 * rather than guessed, so the picker never offers a level the model refuses.
 */
export const FALLBACK_MODELS: readonly ClaudeCliModel[] = [
  { id: 'default', name: 'Default (recommended)' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
]

/** What the catalog needs to run and cache one discovery. */
export interface CatalogOptions {
  /** Models pinned in configuration; non-empty disables discovery entirely. */
  configured: () => readonly ClaudeCliModel[]
  /** Whether to ask the CLI at all. */
  discover: () => boolean
  binaryPath: () => string | undefined
  cwd: () => string | undefined
  /** How long a successful discovery stays fresh. */
  ttlMs: () => number
  logger?: TransportLogger
  /** Injected for tests; defaults to the real CLI probe. */
  probe?: typeof discoverModels
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number
}

/** Caches one discovery result behind the adapter's model queries. */
export class ModelCatalog {
  readonly #options: CatalogOptions
  readonly #probe: typeof discoverModels
  readonly #now: () => number
  #cached: readonly ClaudeCliModel[] | undefined
  #cachedAt = 0
  /** In-flight probe, shared so concurrent callers spawn one CLI, not several. */
  #inFlight: Promise<readonly ClaudeCliModel[]> | undefined

  constructor(options: CatalogOptions) {
    this.#options = options
    this.#probe = options.probe ?? discoverModels
    this.#now = options.now ?? Date.now
  }

  /**
   * The catalog to advertise right now.
   * @param signal - cancellation for a discovery this call may trigger.
   * @returns configured models, discovered models, or the static fallback.
   */
  async list(signal?: AbortSignal): Promise<readonly ClaudeCliModel[]> {
    const configured = this.#options.configured()
    // A pinned list is a deliberate override; asking the CLI anyway would only
    // spawn a process whose answer gets discarded.
    if (configured.length > 0) return configured
    if (!this.#options.discover()) return FALLBACK_MODELS

    if (this.#cached !== undefined && this.#now() - this.#cachedAt < this.#options.ttlMs()) {
      return this.#cached
    }

    // Concurrent callers share one probe: `listModels` and `resolveModel` are
    // routinely called together, and each spawns a CLI process.
    this.#inFlight ??= this.#refresh(signal)
    try {
      return await this.#inFlight
    } finally {
      this.#inFlight = undefined
    }
  }

  /** Drop the cache so the next query re-probes; used when config changes. */
  invalidate(): void {
    this.#cached = undefined
    this.#cachedAt = 0
  }

  async #refresh(signal?: AbortSignal): Promise<readonly ClaudeCliModel[]> {
    const binaryPath = this.#options.binaryPath()
    const cwd = this.#options.cwd()
    try {
      const discovered = await this.#probe({
        ...binaryPath === undefined ? {} : { binaryPath },
        ...cwd === undefined ? {} : { cwd },
        ...signal === undefined ? {} : { signal },
      })
      if (discovered.length === 0) {
        this.#options.logger?.warn(
          'claude-cli: the CLI reported no models; keeping the built-in catalog',
        )
        return this.#cached ?? FALLBACK_MODELS
      }
      this.#cached = discovered
      this.#cachedAt = this.#now()
      return discovered
    } catch (error) {
      // Discovery is an optimization, not a precondition: a signed-out or
      // offline CLI must still leave the route usable with alias ids.
      this.#options.logger?.warn(
        `claude-cli: model discovery failed, using the built-in catalog (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
      return this.#cached ?? FALLBACK_MODELS
    }
  }
}
