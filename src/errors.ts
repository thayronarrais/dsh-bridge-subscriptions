/**
 * Classify Claude Code failures into the harness error taxonomy.
 *
 * The provider-neutral half of this job is already solved upstream:
 * `isQuotaExceededError` and `isContextWindowExceededError` ship with
 * `@deepseek-ai/dsh-llm` and recognize the wording OpenAI-compatible providers
 * use. Only the Claude-Code-specific surface is added here — subscription
 * window limits, the login prompt, and a missing binary.
 *
 * @module dsh-claude-cli/errors
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** Transient per-window throttling; the request is worth repeating later. */
export const RATE_LIMIT_CODE = 'RATE_LIMIT'
/** The CLI is present but not signed in, or its session expired. */
export const NOT_AUTHENTICATED_CODE = 'INVALID_CREDENTIAL'
/** The `claude` executable could not be found or could not start. */
export const CLI_NOT_FOUND_CODE = 'CLI_NOT_FOUND'
/** The provider went quiet for longer than the configured idle budget. */
export const STREAM_IDLE_TIMEOUT_CODE = 'TIMEOUT'
/** A request field the CLI has no knob for and that cannot be silently dropped. */
export const UNSUPPORTED_OPTION_CODE = 'UNSUPPORTED_OPTION'
/** A reasoning effort this adapter never advertised. */
export const UNKNOWN_REASONING_EFFORT_CODE = 'UNKNOWN_REASONING_EFFORT'
/** Anything else that went wrong between us and the CLI. */
export const TRANSPORT_CODE = 'TRANSPORT'

/**
 * Subscription-window wording. Claude Code reports plan limits in prose rather
 * than as an HTTP status, so this is the only way to tell a five-hour window
 * from a hard quota. Kept narrow on purpose: a false positive here would make
 * the retry plugin sit on a request that will never succeed.
 */
const SUBSCRIPTION_LIMIT = new RegExp(
  String.raw`\b(?:claude\s+ai\s+)?usage\s+limit\s+reached\b`
  + String.raw`|\b(?:5|five)[\s-]hour\s+limit\b`
  + String.raw`|\bweekly\s+limit\s+reached\b`
  + String.raw`|\byou(?:'ve| have)\s+(?:hit|reached)\s+your\s+(?:usage\s+)?limit\b`
  // No trailing \b: `_` is a word character, so requiring one here would miss
  // Anthropic's own `rate_limit_error` type string.
  + String.raw`|\brate[\s_-]?limit`,
  'i',
)

/** The CLI asks the user to sign in rather than returning a 401. */
const NEEDS_LOGIN = new RegExp(
  String.raw`\b(?:please\s+)?run\s+/login\b`
  + String.raw`|\bnot\s+(?:logged\s+in|authenticated)\b`
  + String.raw`|\binvalid\s+api\s+key\b`
  + String.raw`|\bauthentication_error\b`
  + String.raw`|\boauth\s+token\s+(?:expired|revoked)\b`,
  'i',
)

/** A missing or unusable executable, reported by the OS rather than by Claude. */
const CANNOT_START = /\b(?:ENOENT|EACCES|spawn\s+\S+\s+ENOENT|command not found|is not recognized)\b/i

/**
 * Claude Code prints the moment a subscription window reopens, either as a
 * pipe-delimited epoch (`usage limit reached|1740000000`) or as prose.
 */
const RESET_EPOCH = /\|\s*(\d{9,13})\s*$/m

/** Recover the retry delay a limit message advertises, when it advertises one. */
function retryAfterMs(detail: string, now: number): number | undefined {
  const epoch = RESET_EPOCH.exec(detail)?.[1]
  if (epoch === undefined) return undefined
  // Ten digits is seconds, thirteen is milliseconds; both appear in the wild.
  const stamp = epoch.length <= 10 ? Number(epoch) * 1000 : Number(epoch)
  if (!Number.isFinite(stamp)) return undefined
  const delay = stamp - now
  return delay > 0 ? delay : undefined
}

/** Everything we know about a failure, joined so one classifier pass sees it all. */
export interface FailureDetail {
  /** Human-readable text from the CLI, the SDK, or a thrown error. */
  message: string
  /** Process exit code, when the spawn transport has one. */
  exitCode?: number | null
  /** Anything the CLI wrote to stderr. */
  stderr?: string
}

/**
 * Turn a raw Claude Code failure into an `LlmError` with a stable code.
 * @param detail - the collected failure text and process facts.
 * @param now - current epoch milliseconds, injected so the mapping is testable.
 * @returns an error whose `code` the retry policy and UI can route on.
 */
export function classifyFailure(detail: FailureDetail, now: number = Date.now()): LlmError {
  const text = [detail.message, detail.stderr].filter((part) => part !== undefined && part !== '')
    .join('\n')

  if (CANNOT_START.test(text)) {
    return new LlmError(
      `claude-cli: could not start the Claude Code CLI — make sure \`claude\` is installed and on PATH`
      + ` (or set \`binaryPath\`). Details: ${text}`,
      CLI_NOT_FOUND_CODE,
    )
  }
  if (NEEDS_LOGIN.test(text)) {
    return new LlmError(
      `claude-cli: the Claude Code CLI is not signed in. Run \`claude\` once and complete the login,`
      + ` then retry. Details: ${text}`,
      NOT_AUTHENTICATED_CODE,
    )
  }
  if (SUBSCRIPTION_LIMIT.test(text)) {
    const delay = retryAfterMs(text, now)
    return new LlmError(
      `claude-cli: your Claude subscription hit a usage window limit.`
      + `${delay === undefined ? '' : ` It reopens in about ${Math.ceil(delay / 60000)} min.`}`
      + ` This is a plan limit, not an API balance. Details: ${text}`,
      RATE_LIMIT_CODE,
      delay === undefined ? {} : { providerRetryAfterMs: delay },
    )
  }
  // Checked after the subscription window so a plan limit is never mistaken for
  // an exhausted prepaid balance: the two need opposite handling.
  if (isQuotaExceededError(text)) {
    return new LlmError(`claude-cli: account quota exhausted. Details: ${text}`, QUOTA_EXCEEDED_CODE)
  }
  if (isContextWindowExceededError(text)) {
    return new LlmError(
      `claude-cli: the request exceeded the model context window. Details: ${text}`,
      CONTEXT_WINDOW_EXCEEDED_CODE,
    )
  }
  const exit = detail.exitCode === undefined || detail.exitCode === null
    ? ''
    : ` (exit code ${detail.exitCode})`
  return new LlmError(`claude-cli: the Claude Code CLI failed${exit}. Details: ${text}`, TRANSPORT_CODE)
}

/**
 * Render a caught value and classify it in one step.
 * @param value - the caught value from a transport `catch` clause.
 * @param extra - process facts the catch site knows about.
 * @returns the classified error, passed through untouched if it already is one.
 */
export function classifyThrown(value: unknown, extra: Omit<FailureDetail, 'message'> = {}): LlmError {
  if (value instanceof LlmError) return value
  return classifyFailure({ message: errorChain(value), ...extra })
}

/**
 * Reduce an error to the serializable facts a terminal `finish` carries.
 * `LlmError` already keeps them beside the live Error, so this is just the
 * named accessor the transports read.
 * @param error - a classified failure.
 * @returns the failure record for `FinishReason`.
 */
export function toFailure(error: LlmError): LlmFailure {
  return error.failure
}
