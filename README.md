# dsh-bridge-subscriptions

**English** · [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns the coding CLIs you **already pay a subscription for** into ordinary provider routes. Harness agents then run on that subscription instead of pay-as-you-go API calls.

One plugin, one row in the profile, one settings section — with a **bridge per CLI inside it**, each switchable on its own:

| Bridge | Route | Backend | Status |
|---|---|---|---|
| Claude Code | `claude-cli` | locally installed, already-signed-in `claude` | **shipping** |
| Codex | `codex-cli` | ChatGPT subscription via the Codex CLI | [planned](#roadmap) |

Each bridge implements `LlmAdapter` from `@deepseek-ai/dsh-llm`: streaming text, streaming tool calls, token usage, cancellation, and subscription-limit classification.

## Requirements

| | |
|---|---|
| Node | `^22.19.0 \|\| >=24` |
| `claude` | installed, on `PATH`, and signed in — run `claude` once interactively and complete the login |
| DeepSeek Harness | `@deepseek-ai/dsh` `0.1.0-rc.7` or newer |
| pnpm | required by `dsh plugin`, which manages the profile directory through it |

Verify the CLI works headlessly **before** installing the plugin. If this prints NDJSON, the bridge will work; if it prints a login prompt, nothing else will help:

```bash
claude -p "ping" --output-format stream-json --verbose
```

## Install

```bash
dsh plugin --profile web add dsh-bridge-subscriptions
```

Then open **Settings → Models** in the harness web UI and pick a model under **Claude Code (subscription)**. There is no API key field — the CLI owns the session.

Substitute another profile for `web` (`tui`, `headless`, …) to install into it instead.

**Prefer this form.** The published tarball ships a prebuilt `lib/`, so the install runs no build scripts at all and pnpm never has to be talked into anything.

### Installing from GitHub

Possible, but it takes an extra step, and it is worth knowing why before you start.

```bash
dsh plugin --profile web add github:thayronarrais/dsh-bridge-subscriptions
```

That fails the first time:

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
The git-hosted package "dsh-bridge-subscriptions@0.1.0" needs to execute build
scripts but is not in the "allowBuilds" allowlist.
```

A git-hosted package arrives as source and has to be compiled by its `prepare` script, and pnpm refuses to run that until you say so. The error prints the **exact key** to add — it is pinned to the commit, so a bare package name will not do. Copy it verbatim into `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-bridge-subscriptions@github:thayronarrais/dsh-bridge-subscriptions#<commit-sha>: true
```

Then run the same `add` command again.

Because the key is commit-pinned, it has to be renewed every time you update from GitHub. That is the whole reason the npm form is recommended.

### Development loop

Patch it in from a working tree without installing:

```bash
npx dsh web --patch ./cordis.patch.yml
```

### Why it mounts

`dsh plugin add` only installs a package. What makes it *mount* is the `dsh.bundle.patch` field in `package.json`, pointing at [`cordis.patch.yml`](cordis.patch.yml): the CLI sees it, adds the package to the profile's `dsh.profile.bundles` list, and applies the patch as a profile layer. Without that field you get a warning that the package was installed as a plain dependency — and it never loads.

The harness's own `@deepseek-ai/dsh-*` packages are declared here as **peerDependencies**, never dependencies. That is deliberate: installing a second copy of `@deepseek-ai/dsh-llm` into the profile would shadow the running harness's instance, and the bridge would register against a runtime nobody is using.

## Turning a bridge on and off

Each bridge has its own `enabled` flag, so you can stop using one without uninstalling the plugin or disturbing the others:

```yaml
# $DSH_HOME/settings.yaml
bridge-subscriptions:
  claude:
    enabled: false
```

A disabled bridge **withdraws its route** from the registry — the harness stops offering its models and refuses requests to it — but stays declared as a configurable provider, so it keeps its row in **Settings → Models** and can be switched back on. Nothing is reinstalled; the change lands on the next request.

That distinction is why the plugin declares its providers separately from registering their routes: declaring a provider is about what *exists*, registering a route is about what currently *serves*.

## Configuration

Everything lives under a per-bridge section. Every field is optional, and the bundle patch deliberately sets none of them: a patch replaces a row's whole `config` rather than merging into it, so inlining defaults would shadow the `bridge-subscriptions:` section of `$DSH_HOME/settings.yaml` that the Models page writes.

### `claude`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether this bridge serves requests. |
| `transport` | `sdk` | `sdk` (Agent SDK) or `spawn` (`claude -p`). Only `sdk` supports tools. |
| `binaryPath` | resolved on `PATH` | Override for the `claude` executable. |
| `cwd` | harness process cwd | Working directory for the provider process. |
| `discoverModels` | `true` | Ask the CLI which models it can reach. |
| `models` | *(empty)* | Pinned catalog. Non-empty overrides discovery entirely. |
| `modelCacheTtlMs` | `600000` | How long a discovered catalog stays fresh. |
| `defaultContextWindow` | `200000` | Used when the selected model has no exact value. |
| `defaultEffort` | *(unset)* | Reasoning effort when the caller picks none. |
| `maxTurns` | `2` | Ceiling on Claude Code's *own* turns. |
| `streamIdleTimeoutMs` | `300000` | Maximum provider silence during one read. |
| `maxPromptBytes` | `2000000` | Conversation budget; oldest turns drop first. |
| `retryPolicy` | harness default | Provider-owned policy consumed by `llm-retry`. |

Settings changes take effect on the next request without restarting the server. Changing `binaryPath`, `cwd`, `models`, or `discoverModels` also drops the cached catalog, so the picker cannot keep showing models read from a previous CLI.

### Models and reasoning effort

The catalog is **discovered from the CLI**, not hardcoded. Asking is free: discovery is a control request over a query that never sends a prompt, so it consumes no subscription quota.

That matters for two things a static list gets wrong:

- **Versions.** The harness picker shows the model name and little else, so the resolved wire id rides along in it — `Opus (1M context) · claude-opus-5[1m]` instead of a bare `opus`. A `[1m]` suffix also sets the context window to 1M rather than the 200k default.
- **Effort.** Effort support is per model, and the CLI is the only authority on it. On the current CLI every model accepts all five levels except Haiku, which accepts none — so Haiku correctly gets no effort picker at all, rather than one whose settings are ignored.

A `defaultEffort` the selected model does not offer is dropped instead of sent. If discovery fails — CLI missing, signed out, offline — the route stays usable on a small alias-only fallback catalog, and the next query retries.

## How it works

### A harness is not a model

This is the part that surprises people, so it is worth stating plainly: **DeepSeek Harness contains no intelligence of its own.** It is the machinery *around* a model — the tool registry, the sandbox and permission policy, session state and compaction, prompt assembly, and the agent loop. Every decision comes from the model. That used to be DeepSeek; with this plugin it is Claude, running on your subscription.

So when you ask the harness to build a web page and watch it create files and run commands, nothing has been smuggled in. Claude decided; the harness executed.

### The loop

```
┌─ the harness assembles a request ─────────────────────┐
│  system prompt + tool schemas + conversation history  │
└───────────────────────┬───────────────────────────────┘
                        │  this plugin → claude -p
                        ▼
                  ┌───────────┐
                  │  Claude   │   text, or a tool call?
                  └─────┬─────┘
                        │  tool call: write_file("index.html", …)
┌───────────────────────▼───────────────────────────────┐
│  the HARNESS executes the tool — it owns the disk,    │
│  the shell, and the permission prompt                 │
│  the result is appended to the history                │
└───────────────────────┬───────────────────────────────┘
                        │
                        └──▶ back to the top, until Claude stops asking
```

Claude never touches your files. It returns *data* saying it wants `write_file` called with certain arguments, and the harness carries that out — inside its own sandbox, under its own permission policy, recorded in its own session log. Keeping it that way is the whole job of the MCP bridge and the abort described below.

### One loop, not two

Claude Code is an agent harness in its own right. Nested inside another one, the two compete: Claude Code would edit files and run commands that the harness session log never sees, while the harness ran its own loop over the same task.

Every call therefore strips Claude Code of its agency — no built-in tools, no MCP servers of its own, no `CLAUDE.md` or user settings (`settingSources: []`), and a hard turn ceiling. The harness composes the prompt; Claude Code answers it and nothing more.

### What it costs

**Token usage does not double.** Two harnesses are not two models: there is one agent loop and one model call per step.

There is real fixed overhead, though. Measured on this setup, with the system prompt replaced and no tools published:

| | tokens |
|---|---|
| Claude Code's own context, first call | 28,098 (cache write) |
| The same context, next call | 28,021 (cache read) |
| Our own fresh input | 2 |

That block cannot be removed. It is server-side prompt-cached and survives across process boundaries — the two measurements above come from separate `claude` invocations, and the second already arrived as a cache read.

What matters in practice is that **every loop step is a fresh call**: a task with eight tool calls means eight `claude` invocations, each carrying that block (usually cached, never free) plus a process spawn.

Re-sending the whole conversation on every step is *not* part of this overhead — that is how every agent loop works, Claude Code's own included.

### What you actually gain

**You pay a flat subscription instead of per-token API billing.** That is the entire benefit: the harness you want to use, its UI, plugins, tools, and session model, driven by Claude, without pay-as-you-go charges.

It is worth being equally clear about the other side. **On raw efficiency, using Claude Code directly wins.** It keeps a warm session with an optimized context, no fixed overhead per step, no flattening of a structured message array into one text document. If the goal were to spend fewer tokens per task, this bridge would be the wrong tool.

The bridge earns its place when DeepSeek Harness is the harness you want — for what surrounds the model — and a subscription is how you want to pay for it.

### Tool calls come back as data, never executed

Claude Code does not accept arbitrary tool schemas as a parameter. The one seam that admits foreign tools is MCP, so `GenerateOptions.tools` is published through an **in-process MCP server**, which yields native `tool_use` blocks with incremental `input_json_delta` — no regex over markdown.

The server is built on the low-level protocol server rather than the SDK's `tool()` helper, because that helper takes a Zod raw shape and the harness hands us JSON Schema; a JSON-Schema → Zod → JSON-Schema round trip would silently drop whatever the converter does not model. The schema goes out byte for byte.

Two details are load-bearing:

- Each tool carries `_meta['anthropic/alwaysLoad']`. Without it the tools are deferred behind Claude Code's own `ToolSearch`, and the model burns its turn searching for the tool instead of calling it.
- As soon as a tool call is assembled, the transport **aborts** the provider. That is what prevents execution; the MCP call handler is only a backstop.

The harness then executes the tool and calls back with the result, exactly as it would for any other provider.

### Subscription limits

Claude Code reports plan limits in prose, not as an HTTP status. A five-hour or weekly window limit is classified as `RATE_LIMIT` with `providerRetryAfterMs` when the reset time is advertised — deliberately distinct from `QUOTA` (an exhausted balance), because the two need opposite handling: one waits, the other cannot succeed by waiting. Retrying itself is left to the `llm-retry` plugin; this bridge only declares the policy.

## Known limitations

These are design consequences, not unfinished work.

- **No attribution headers.** `LlmAdapter` requires every provider HTTP request to carry `attributionHeaders()`. This bridge issues no HTTP of its own — the official CLI talks to Anthropic and sends its own `User-Agent`, with no override. Satisfying the contract would mean proxying the subscription credential directly, which is exactly what this plugin refuses to do.
- **Images only on the newest turn, and only on `sdk`.** The Agent SDK's streaming-input prompt is the one channel that carries image bytes, so `listModels`/`resolveModel` declare `inputModalities: ['text', 'image']` only when `transport: sdk` *and* the host mounts the attachment service; otherwise they declare `['text']` and the harness refuses images at the tool boundary. Only the newest user turn's images are sent as bytes — resending every image on every turn would put the whole conversation's base64 on the wire each round — so images further back stay in the flattened document as `<image … note="sent earlier in this conversation; bytes not resent" />`.
- **No stop sequences.** The CLI exposes no stop-sequence option. Because ignoring `stop` would change what the model may produce without the caller knowing, the request is refused with `UNSUPPORTED_OPTION`.
- **`temperature` and `maxTokens` are ignored**, with one warning per adapter instance. They have no CLI equivalent at all, and failing every request over an advisory shaping hint would make the provider useless.
- **Fixed overhead.** Claude Code injects roughly 28k tokens of its own context per call — measured on a plain text request with the system prompt replaced and no tools published. It is prompt-cached, so after the first call it shows up as `cacheReadTokens` rather than fresh input, but it cannot be removed.
- **The `spawn` transport is text-only.** The MCP bridge is an in-process server object and cannot cross a process boundary, the prompt travels as text over stdin, and the installed CLI exposes no `--max-turns`. A call carrying tools or images is refused instead of degrading to prose.

## Roadmap

### Codex / ChatGPT subscription — planned

The same treatment for the **Codex CLI**, so a ChatGPT Plus/Pro subscription can drive the harness too. It lands as a `codex` section beside `claude` in this same plugin — a second bridge, not a second package, switchable independently through its own `enabled` flag.

What carries over unchanged:

- the `StreamChunk` protocol translator and its invariants
- the containment idea — demote an agentic CLI to a completion endpoint, keep one loop
- capture-and-abort tool interception
- the error taxonomy, the catalog cache, and the effort plumbing

What has to be rebuilt: the wire-event mapping (Codex speaks its own stream format, not Anthropic's), model discovery, and whatever containment flags that CLI exposes.

The same rule applies as here — drive the **official CLI**, never lift a subscription token out of its credential store.

## Terms of service

This plugin works by **invoking official vendor CLIs**, which are first-party clients using their own sessions.

It deliberately does **not** read the OAuth token out of `~/.claude/.credentials.json`, and does not proxy a subscription credential to `api.anthropic.com`. Anthropic's terms restrict Claude Pro/Max to Anthropic's own interfaces and prohibit proxying or reselling access. Some community plugins take the token-extraction route; this one does not, and the limitations above are the price of that choice.

You are responsible for your own compliance with each vendor's terms.

## Development

```bash
npm run typecheck && npm test && npm run build
```

The suite is layered:

| File | What it pins down |
|---|---|
| `tests/events.spec.ts` | The `StreamChunk` protocol invariants, over NDJSON recorded from real calls. |
| `tests/errors.spec.ts` | Failure classification, including plan-limit vs. exhausted-quota. |
| `tests/request.spec.ts` | Conversation flattening, escaping, and byte-budget truncation. |
| `tests/catalog.spec.ts` | Discovery caching, in-flight sharing, and the fallback when the CLI cannot answer. |
| `tests/effort.spec.ts` | Per-model effort advertising and the path from a chosen level to the transport request. |
| `tests/plugin.spec.ts` | Real composition: mounts `LlmRuntime` and this plugin on a Cordis context, and asserts route registration, model resolution, and enable/disable. |

Live tests exercise the real CLI and consume subscription usage, so they are skipped unless opted in. They are the only tests that catch drift between this plugin's containment options and the installed CLI — in particular whether harness tools still reach the model directly instead of being deferred behind `ToolSearch`:

```bash
DSH_CLAUDE_LIVE=1 npx vitest run
```

On PowerShell:

```bash
$env:DSH_CLAUDE_LIVE='1'; npx vitest run
```

The live pass in `tests/plugin.spec.ts` drives a generation through `ctx.llm.stream()` into a `BlockAssembler` — the same path the agent loop takes — rather than calling the adapter directly.

### Adding a bridge

A new bridge is a section in `Config`, an entry in the provider declaration, and an `LlmAdapter`. The protocol translator, error taxonomy, catalog cache, and effort plumbing are provider-neutral and meant to be reused.

## License

MIT
