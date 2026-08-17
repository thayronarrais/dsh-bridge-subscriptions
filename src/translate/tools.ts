/**
 * Expose the harness's tool schemas to Claude Code and trap the resulting
 * calls.
 *
 * Claude Code does not accept arbitrary tool schemas as a parameter — it owns
 * its tool set. The one seam that admits foreign tools is MCP, so the harness
 * tools are published through an in-process MCP server. That buys native,
 * structured `tool_use` blocks with incremental `input_json_delta`, instead of
 * scraping JSON out of prose.
 *
 * Two details are load-bearing, both learned the hard way:
 *
 * 1. Request handlers are installed on the low-level server rather than through
 *    `registerTool()` or the Agent SDK's `tool()` helper, because both take a
 *    Zod raw shape. The harness hands us JSON Schema, and a
 *    JSON-Schema-to-Zod-to-JSON-Schema round trip would silently drop whatever
 *    the converter does not model. The low-level handler returns the harness's
 *    schema byte for byte. The outer `McpServer` wrapper is kept only because
 *    that is the type the Agent SDK's `sdk`-transport config accepts.
 * 2. Every tool is marked `anthropic/alwaysLoad`. Without it the tools are
 *    deferred behind Claude Code's own `ToolSearch`, and the model spends its
 *    single turn searching for the tool instead of calling it.
 *
 * Execution never happens here: the transport aborts as soon as a tool call is
 * assembled, so the call handler is a backstop rather than the mechanism.
 *
 * @module dsh-claude-cli/translate/tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** MCP server name; also the middle segment of every namespaced tool name. */
export const BRIDGE_SERVER_NAME = 'dsh'

/** Claude Code's namespacing for MCP tools. */
const NAMESPACE_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`

/**
 * Strip the MCP namespace Claude Code adds, so the loop sees the tool name it
 * asked for. Names that were never namespaced pass through untouched.
 * @param wireName - the tool name as it appears on the wire.
 * @returns the harness-facing tool name.
 */
export function unnamespaceToolName(wireName: string): string {
  return wireName.startsWith(NAMESPACE_PREFIX) ? wireName.slice(NAMESPACE_PREFIX.length) : wireName
}

/**
 * The namespaced name Claude Code will use for one harness tool.
 * @param toolName - the harness-facing tool name.
 * @returns the wire name to put in `allowedTools`.
 */
export function namespaceToolName(toolName: string): string {
  return `${NAMESPACE_PREFIX}${toolName}`
}

/** Everything the transport needs to publish and then trap one call's tools. */
export interface ToolBridge {
  /** Live MCP server instance handed to the SDK as an `sdk`-type server. */
  server: McpServer
  /** Exact `allowedTools` whitelist for this call. */
  allowedTools: string[]
}

/**
 * Publish the harness tool schemas as an in-process MCP server.
 * @param tools - the schemas from `GenerateOptions.tools`.
 * @returns the server plus the whitelist naming exactly those tools.
 */
export function createToolBridge(tools: readonly ToolSchema[]): ToolBridge {
  const mcp = new McpServer(
    { name: BRIDGE_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  // `McpServer.registerTool` would insert its own Zod-shaped handlers; going
  // straight to the underlying protocol server keeps the harness JSON Schema
  // intact. Nothing else registers tools here, so nothing is being overridden.
  const server = mcp.server

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // The harness JSON Schema, verbatim — no conversion, no loss.
      inputSchema: tool.parameters as { type: 'object' },
      _meta: { 'anthropic/alwaysLoad': true },
    })),
  }))

  // Reached only if a call slips past the transport's abort. Returning an
  // error keeps Claude Code from inventing a result and pressing on as though
  // the tool had run.
  server.setRequestHandler(CallToolRequestSchema, (request) => ({
    content: [{
      type: 'text' as const,
      text: `${request.params.name} is executed by the DeepSeek Harness, not here.`,
    }],
    isError: true,
  }))

  return { server: mcp, allowedTools: tools.map((tool) => namespaceToolName(tool.name)) }
}

/**
 * Claude Code's own tools. The harness owns the agent loop, so every one of
 * these is refused: a file Claude Code edits behind the loop's back is a change
 * the session log never sees.
 */
export const BUILTIN_TOOLS: readonly string[] = [
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Skill',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]
