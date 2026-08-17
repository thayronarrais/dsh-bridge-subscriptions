/**
 * Ask the Claude Code CLI which models it can actually reach.
 *
 * Hardcoding a catalog goes stale and lies in two directions: it hides the real
 * model version behind an alias like `opus`, and it cannot know which models
 * accept an effort level — on this CLI, Haiku accepts none while every other
 * model accepts all five. `supportedModels()` answers both authoritatively.
 *
 * Discovery is a control request, not a completion: the query is opened with a
 * prompt that never emits, so the CLI starts, answers, and closes without
 * consuming any subscription quota.
 *
 * @module dsh-claude-cli/discovery
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelInfo, Options } from '@anthropic-ai/claude-agent-sdk'
import { EFFORT_LEVELS, isEffortLevel } from './effort.ts'
import type { ClaudeCliModel } from './model.ts'

/** A model the CLI reported; the same shape as a pinned catalog entry. */
export type DiscoveredModel = ClaudeCliModel

/** Inputs for one discovery attempt. */
export interface DiscoverOptions {
  binaryPath?: string
  cwd?: string
  /** Abort the attempt; discovery must never outlive the caller's patience. */
  signal?: AbortSignal
}

/**
 * A `[1m]` suffix in a Claude Code model id is an explicit context marker, not
 * prose — `claude-opus-5[1m]` is the million-token variant of `claude-opus-5`.
 */
const ONE_MILLION_CONTEXT = /\[1m\]/i
const ONE_MILLION = 1_000_000

/** Map one CLI model row into the plugin's catalog shape. */
function toDiscovered(info: ModelInfo): DiscoveredModel {
  const resolved = info.resolvedModel
  // The harness model picker shows the name and little else, so the resolved
  // wire id rides along in it: an alias row like `opus[1m]` otherwise gives the
  // user no way to see which model version they are actually talking to.
  const name = resolved === undefined || resolved === info.value
    ? info.displayName
    : `${info.displayName} · ${resolved}`

  const declared = info.supportedEffortLevels?.filter(isEffortLevel) ?? []
  // `supportsEffort` without an explicit list means the standard five.
  const efforts = declared.length > 0
    ? declared
    : info.supportsEffort === true
      ? [...EFFORT_LEVELS]
      : []

  const wide = ONE_MILLION_CONTEXT.test(info.value)
    || (resolved !== undefined && ONE_MILLION_CONTEXT.test(resolved))

  return {
    id: info.value,
    name,
    ...info.description === undefined || info.description === ''
      ? {}
      : { description: info.description },
    ...wide ? { contextWindow: ONE_MILLION } : {},
    ...efforts.length > 0 ? { efforts } : {},
  }
}

/** A prompt that never yields, so the CLI stays up for control requests only. */
function idlePrompt(signal: AbortSignal): AsyncIterable<never> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
}

/**
 * Ask the CLI for its model catalog.
 * @param options - executable location and cancellation.
 * @returns the reported models, in the CLI's own order.
 * @throws whatever the SDK throws when the CLI is missing or not signed in.
 */
export async function discoverModels(options: DiscoverOptions = {}): Promise<DiscoveredModel[]> {
  const controller = new AbortController()
  const forward = (): void => controller.abort()
  options.signal?.addEventListener('abort', forward, { once: true })

  const sdkOptions: Options = {
    // The same containment the real calls use: discovery must not pick up the
    // user's settings, MCP servers, or tools just to read a model list.
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    allowedTools: [],
    abortController: controller,
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    ...options.binaryPath === undefined ? {} : { pathToClaudeCodeExecutable: options.binaryPath },
  }

  const session = query({ prompt: idlePrompt(controller.signal), options: sdkOptions })
  try {
    return (await session.supportedModels()).map(toDiscovered)
  } finally {
    options.signal?.removeEventListener('abort', forward)
    controller.abort()
    session.close()
  }
}
