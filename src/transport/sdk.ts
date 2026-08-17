/**
 * Primary transport: drive Claude Code through the official Agent SDK.
 *
 * Preferred over spawning `claude` directly because the SDK already owns the
 * parts that are easy to get wrong on Windows — argument quoting, locating the
 * executable, framing the NDJSON stream, and tearing the child process down on
 * cancellation.
 *
 * The interesting work here is not transport, it is *containment*: Claude Code
 * is an agent harness in its own right, and this adapter needs it to behave
 * like a plain completion endpoint. See {@link containmentOptions}.
 *
 * @module dsh-claude-cli/transport/sdk
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { classifyFailure, classifyThrown, STREAM_IDLE_TIMEOUT_CODE, toFailure } from '../errors.ts'
import { StreamTranslator } from '../translate/events.ts'
import type { StreamOutcome } from '../translate/events.ts'
import {
  BRIDGE_SERVER_NAME,
  BUILTIN_TOOLS,
  createToolBridge,
  unnamespaceToolName,
} from '../translate/tools.ts'
import { isWireEvent } from '../wire.ts'
import { withIdleTimeout } from './idle.ts'
import type { TransportRequest } from './types.ts'

/** `result` subtypes that mean the call genuinely failed. */
const FAILING_RESULT_SUBTYPES = new Set(['error_during_execution', 'error'])

/**
 * Options that strip Claude Code of its own agency for the duration of a call.
 *
 * Every entry here is load-bearing:
 * - `settingSources: []` keeps the user's `CLAUDE.md`, project settings, and
 *   personal slash commands out of a request the harness composed. Without it
 *   the prompt silently differs from what the loop believes it sent.
 * - `disallowedTools` refuses the built-ins, so Claude Code cannot touch the
 *   filesystem behind the loop's back.
 * - `strictMcpConfig` keeps the user's own MCP servers out of the call.
 * - `maxTurns` bounds the nested loop; the harness runs the real one.
 */
function containmentOptions(request: TransportRequest): Options {
  return {
    settingSources: [],
    strictMcpConfig: true,
    disallowedTools: [...BUILTIN_TOOLS],
    includePartialMessages: true,
    maxTurns: request.maxTurns,
    systemPrompt: request.systemPrompt,
    ...request.model === undefined ? {} : { model: request.model },
    ...request.effort === undefined ? {} : { effort: request.effort },
    ...request.cwd === undefined ? {} : { cwd: request.cwd },
    ...request.binaryPath === undefined ? {} : { pathToClaudeCodeExecutable: request.binaryPath },
  }
}

/**
 * Stream one call through the Agent SDK.
 * @param request - the prepared provider call.
 * @returns harness chunks, terminating in exactly one `finish`.
 */
export async function* streamViaSdk(request: TransportRequest): AsyncIterable<StreamChunk> {
  const translator = new StreamTranslator({ toolName: unnamespaceToolName })
  const controller = new AbortController()

  const abortFromCaller = (): void => {
    controller.abort(request.signal?.reason)
  }
  if (request.signal?.aborted === true) abortFromCaller()
  request.signal?.addEventListener('abort', abortFromCaller, { once: true })

  const bridge = request.tools.length > 0 ? createToolBridge(request.tools) : undefined
  const options: Options = {
    ...containmentOptions(request),
    abortController: controller,
    ...bridge === undefined
      ? { mcpServers: {}, allowedTools: [] }
      : {
        // Keeping these tools out of Claude Code's ToolSearch is the job of the
        // per-tool `anthropic/alwaysLoad` metadata the bridge attaches; the
        // `sdk` server config has no such field.
        mcpServers: {
          [BRIDGE_SERVER_NAME]: { type: 'sdk', name: BRIDGE_SERVER_NAME, instance: bridge.server },
        },
        allowedTools: bridge.allowedTools,
      },
  }

  /** Set once we stop the provider ourselves, so its abort is not read as a failure. */
  let intercepted = false
  let outcome: StreamOutcome = { kind: 'natural' }

  try {
    const messages = withIdleTimeout(
      query({ prompt: request.prompt, options }) as AsyncIterable<SDKMessage>,
      request.idleTimeoutMs,
      () => new LlmError(
        `claude-cli: no output from the Claude Code CLI for ${request.idleTimeoutMs}ms`,
        STREAM_IDLE_TIMEOUT_CODE,
      ),
    )

    for await (const message of messages) {
      if (message.type === 'stream_event') {
        const event: unknown = message.event
        if (isWireEvent(event)) yield* translator.push(event)
        continue
      }

      if (message.type === 'assistant' && translator.sawToolCall) {
        // The turn produced a tool call. Stop the provider before it can run
        // the call itself — the harness executes tools, and a side effect
        // applied here would never reach the session log.
        intercepted = true
        outcome = { kind: 'intercepted-tool-calls' }
        controller.abort()
        break
      }

      if (message.type === 'result') {
        if (FAILING_RESULT_SUBTYPES.has(message.subtype)) {
          outcome = {
            kind: 'error',
            failure: toFailure(classifyFailure({ message: resultText(message) })),
          }
        }
        // `error_max_turns` is our own ceiling, not a provider failure: the
        // content already streamed is a complete answer for this turn.
        break
      }
    }
  } catch (error) {
    if (intercepted || isAbort(error)) {
      if (!intercepted) {
        const reason = request.signal?.reason
        outcome = {
          kind: 'aborted',
          failure: toFailure(classifyThrown(reason ?? new Error('the request was aborted'))),
        }
      }
    } else {
      outcome = { kind: 'error', failure: toFailure(classifyThrown(error)) }
    }
  } finally {
    request.signal?.removeEventListener('abort', abortFromCaller)
    // Also covers the consumer abandoning this generator mid-stream: the loop
    // above never reaches a terminal message, so without this the child process
    // would outlive the request. A no-op once the query has already finished.
    controller.abort()
  }

  yield* translator.end(outcome)
}

/** Pull whatever failure text a `result` message carries. */
function resultText(message: Extract<SDKMessage, { type: 'result' }>): string {
  const withResult = message as { result?: unknown; subtype: string }
  return typeof withResult.result === 'string' && withResult.result !== ''
    ? withResult.result
    : `Claude Code ended with subtype "${message.subtype}"`
}

/** Recognize the abort a cancelled `query()` throws, whoever triggered it. */
function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const named = error as { name?: unknown; message?: unknown }
  return named.name === 'AbortError'
    || (typeof named.message === 'string' && /abort/i.test(named.message))
}
