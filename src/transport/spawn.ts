/**
 * Fallback transport: run `claude -p` as a subprocess and parse its NDJSON.
 *
 * This exists as an escape hatch for when the Agent SDK is unavailable or has
 * drifted from the installed CLI. It is deliberately narrower than the SDK
 * transport, and the gaps are real rather than unfinished work:
 *
 * - **No tool calling.** The MCP bridge is an in-process server object; there
 *   is no way to hand one to a separate process. A call carrying tools is
 *   refused here instead of silently degrading to prose.
 * - **No turn ceiling.** The installed CLI exposes no `--max-turns`, so the
 *   nested loop is bounded only by the disallowed built-ins and the idle
 *   timeout.
 * - **System prompt travels in the prompt document**, not `--system-prompt`,
 *   for the same reason the conversation does: argv is a length-limited channel
 *   and the system prompt is caller-sized.
 *
 * @module dsh-claude-cli/transport/spawn
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  classifyFailure,
  classifyThrown,
  STREAM_IDLE_TIMEOUT_CODE,
  toFailure,
  UNSUPPORTED_OPTION_CODE,
} from '../errors.ts'
import { StreamTranslator } from '../translate/events.ts'
import type { StreamOutcome } from '../translate/events.ts'
import { BUILTIN_TOOLS } from '../translate/tools.ts'
import { isWireEvent } from '../wire.ts'
import { withIdleTimeout } from './idle.ts'
import { NdjsonSplitter, parseNdjsonLine } from './ndjson.ts'
import type { TransportRequest } from './types.ts'

/** Build the argument vector. Everything here is short and fixed-size by design. */
function buildArgs(request: TransportRequest): string[] {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Load no user, project, or local settings: the harness composed this
    // request, and a stray CLAUDE.md would change it without anyone knowing.
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--disallowed-tools', BUILTIN_TOOLS.join(','),
  ]
  if (request.model !== undefined) args.push('--model', request.model)
  if (request.effort !== undefined) args.push('--effort', request.effort)
  return args
}

/** Kill the whole process tree; on Windows a plain `kill` orphans the children. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    // Detached and fully ignored: teardown must never itself block or throw.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      .on('error', () => child.kill('SIGKILL'))
    return
  }
  child.kill('SIGKILL')
}

/** Yield stdout lines until the process ends, surfacing spawn and exit failures. */
async function* readLines(
  child: ChildProcessWithoutNullStreams,
  stderr: { text: string },
): AsyncIterable<string> {
  const splitter = new NdjsonSplitter()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (piece: string) => {
    // Bounded so a chatty failure cannot grow without limit before we read it.
    stderr.text = (stderr.text + piece).slice(-8192)
  })

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    },
  )

  for await (const chunk of child.stdout) {
    for (const line of splitter.push(chunk as Uint8Array)) yield line
  }
  for (const line of splitter.flush()) yield line

  const { code } = await exited
  if (code !== null && code !== 0) {
    throw classifyFailure({
      message: 'the Claude Code CLI exited with a failure status',
      exitCode: code,
      stderr: stderr.text,
    })
  }
}

/**
 * Stream one call by spawning the CLI.
 * @param request - the prepared provider call; must carry no tools.
 * @returns harness chunks, terminating in exactly one `finish`.
 */
export async function* streamViaSpawn(request: TransportRequest): AsyncIterable<StreamChunk> {
  if (request.tools.length > 0) {
    throw new LlmError(
      'claude-cli: the spawn transport cannot expose tools — the MCP bridge is an in-process server'
      + ' and does not survive a process boundary. Set `transport: sdk` for tool-calling sessions.',
      UNSUPPORTED_OPTION_CODE,
    )
  }
  if ((request.images ?? []).length > 0) {
    // Unreachable through normal routing, since the adapter only declares image
    // input on the SDK transport. Refused rather than sent as prose about bytes
    // that never arrived, for the same reason tools are.
    throw new LlmError(
      'claude-cli: the spawn transport cannot carry images — the prompt travels as text over stdin.'
      + ' Set `transport: sdk` for sessions with attachments.',
      UNSUPPORTED_OPTION_CODE,
    )
  }

  const translator = new StreamTranslator()
  const stderr = { text: '' }
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(request.binaryPath ?? 'claude', buildArgs(request), {
      cwd: request.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    throw classifyThrown(error)
  }

  const onAbort = (): void => killTree(child)
  request.signal?.addEventListener('abort', onAbort, { once: true })

  // The whole conversation goes in over stdin. Closing the pipe is what tells
  // the CLI the prompt is complete.
  child.stdin.on('error', () => {
    // A child that died before reading gives EPIPE here; the real diagnosis is
    // the exit status, which `readLines` reports.
  })
  child.stdin.end(`${request.systemPrompt}\n\n${request.prompt}`, 'utf8')

  let outcome: StreamOutcome = { kind: 'natural' }
  try {
    const lines = withIdleTimeout(
      readLines(child, stderr),
      request.idleTimeoutMs,
      () => new LlmError(
        `claude-cli: no output from the Claude Code CLI for ${request.idleTimeoutMs}ms`,
        STREAM_IDLE_TIMEOUT_CODE,
      ),
    )
    for await (const line of lines) {
      const message = parseNdjsonLine(line)
      if (typeof message !== 'object' || message === null) continue
      const envelope = message as { type?: unknown; event?: unknown; subtype?: unknown; result?: unknown }
      if (envelope.type === 'stream_event' && isWireEvent(envelope.event)) {
        yield* translator.push(envelope.event)
      } else if (envelope.type === 'result' && typeof envelope.subtype === 'string'
        && envelope.subtype !== 'success') {
        outcome = {
          kind: 'error',
          failure: toFailure(classifyFailure({
            message: typeof envelope.result === 'string' && envelope.result !== ''
              ? envelope.result
              : `Claude Code ended with subtype "${envelope.subtype}"`,
            stderr: stderr.text,
          })),
        }
      }
    }
  } catch (error) {
    outcome = request.signal?.aborted === true
      ? { kind: 'aborted', failure: toFailure(classifyThrown(request.signal.reason)) }
      : { kind: 'error', failure: toFailure(classifyThrown(error, { stderr: stderr.text })) }
  } finally {
    request.signal?.removeEventListener('abort', onAbort)
    killTree(child)
  }

  yield* translator.end(outcome)
}
