/**
 * Reasoning-effort vocabulary shared by the adapter, discovery, and transports.
 *
 * Lives in its own module so discovery can describe a model's effort support
 * without importing the adapter that consumes it.
 *
 * @module dsh-claude-cli/effort
 */

/**
 * Effort levels Claude Code accepts, in increasing depth. Mirrors the Agent
 * SDK's `EffortLevel` and the CLI's `--effort` flag.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every level, in display order. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Display metadata for the harness effort picker.
 *
 * Which levels a model actually honors is answered per model by discovery, not
 * by this table — on the current CLI, Haiku honors none while the rest honor
 * all five.
 */
export const EFFORT_DISPLAY: Record<EffortLevel, { name: string; description: string }> = {
  low: { name: 'Low', description: 'Minimal thinking, fastest responses.' },
  medium: { name: 'Medium', description: 'Moderate thinking.' },
  high: { name: 'High', description: 'Deep reasoning. Claude Code\'s own default.' },
  xhigh: { name: 'Extra high', description: 'Deeper than high.' },
  max: { name: 'Max', description: 'Maximum effort, slowest.' },
}

/**
 * Narrow an arbitrary string to a known effort level.
 * @param value - candidate level, typically from config or a request.
 * @returns true when the value is one this plugin can send.
 */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}
