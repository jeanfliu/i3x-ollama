# CLAUDE.md

Context for Claude (and humans) contributing to this codebase. Read once before making changes.

## What this is

An MCP server that wraps any [i3X 1.0](https://github.com/cesmii/i3X) compliant manufacturing data source for use from Claude / other MCP clients. Published as `i3x-mcp` on npm; end users install via `npx -y i3x-mcp@latest` in their Claude Desktop config.

## Audience

**End users of i3X-compliant systems** — plant engineers, operators, maintenance — *not* i3X client developers. Every design decision flows from that: tool names, descriptions, input shapes, and error messages should make sense to someone who knows their plant, not someone who's read the i3X spec.

When in doubt: would a plant engineer recognize the input/output? If a tool requires the user (or model) to know about `elementId`, `namespaceUri`, or `maxDepth`, push that complexity *inside* the tool.

## Locked-in design decisions

These aren't up for casual revision — they shape the whole surface. If you want to revisit one, raise it explicitly.

- **Opinionated tool surface**, not a thin 1:1 wrapper of i3X endpoints. ~12 tools, each composed from one or more i3X calls.
- **Read-only by default**; `update_value` and `write_history` only register when `--enable-writes` is passed. Setpoint writes can affect live equipment.
- **Connection is runtime-configurable** via the `connect` tool. Env vars (`I3X_BASE_URL`, etc.) are an optional bootstrap, not a requirement. The server always starts; data tools refuse with a friendly "call `connect` first" message until connected.
- **Catalog cached locally** + fuzzy-searched with fuse.js. i3X has no pagination or full-text search; this is how we make discovery work.
- **Subscriptions are not exposed as a lifecycle**. The single `watch_values` tool creates a subscription, polls `/sync` for a bounded duration (max from `runtime.watchMaxDurationSec`), and tears it down in `finally`. Prevents orphaned subscriptions on the i3X server.
- **History aggregation is server-side**. `get_history` accepts `aggregation: raw|avg|min|max|count` and a `bucket` interval. Raw mode is capped to protect the LLM's context window.
- **Times accept relative strings** (`1h`, `last 30m`, `yesterday`) and RFC 3339. Centralized in `src/time.ts`.
- **Values are enriched with units inline** when the ObjectType schema declares them. Centralized in `src/units.ts`.

## Architecture map

```
src/
  config.ts        env + CLI parsing. Optional initial connection from env vars.
  connection.ts    ConnectionManager — single source of truth for live state
                   (client, catalog, config). Tools read from this at call time.
  i3x-client.ts    Thin HTTP client + i3X type definitions. One method per endpoint.
  catalog.ts       In-memory object/type/relationship index. Built on connect,
                   refresh on demand. Fuse.js for fuzzy search.
  time.ts          parseTimeInput, parseDurationMs, toRfc3339.
  aggregation.ts   raw/avg/min/max/count bucketing over VQT arrays.
  units.ts         Walk an ObjectType JSON Schema for engineering units.
  tools.ts         All MCP tool registrations. ~12 small register* functions.
  index.ts         Entry point. Boots ConnectionManager, registers tools,
                   pre-connects if env vars supplied, connects stdio.
```

## Adding a tool

1. Add a `register<Name>` function in `src/tools.ts`.
2. First line of the handler: `const state = connection.tryGet(); if (!state) return notConnected();`
3. Use `state.client`, `state.catalog`, `state.config` inside.
4. Wrap your logic in `try/catch` and return `errorText(e)` on failure.
5. Use `asText(payload)` for success responses — it JSON-stringifies non-string payloads.
6. Register the new function in `registerTools()` at the top of the file.
7. Add a row to the README's tool table.

If the tool is destructive, set `annotations: { destructiveHint: true, openWorldHint: true }` and only register it under the `if (deps.runtime.enableWrites)` block.

## Conventions

- **Tool descriptions are the model's only documentation**. Lead with what the tool does in plant terms; mention key arguments. Keep under ~300 chars when you can.
- **Tool inputs use zod** raw shape (no `z.object` wrapper). The MCP SDK takes the shape directly.
- **Errors are returned, not thrown**, from tool handlers. Use `errorText(e)` so the model sees `isError: true` and a clean message.
- **Don't log to stdout** — that channel is the MCP wire protocol. Use `console.error` for any operator-visible diagnostics. (Claude Desktop usually swallows stderr; surface user-facing messages through tool results instead.)
- **No comments explaining what code does** — let names and types do that. A short `// why` comment is OK when behavior would surprise a reader.

## Gotchas worth knowing

- **i3X never paginates**. The `/objects` list can be huge; we fetch it once at connect, index locally, and refresh on demand.
- **VQT envelope**: every value carries `quality` (`Good|GoodNoData|Bad|Uncertain`) and a timestamp. `Bad` and `GoodNoData` mean `value: null`. Numeric aggregation must skip them (see `aggregation.ts:numericVQT`).
- **Composition vs hierarchy**: i3X distinguishes `HasComponent` (composition — child values appear nested in parent reads when `maxDepth > 1`) from `HasChildren` (organizational — independent values). Don't conflate them.
- **Subscription state lives on the i3X server**, keyed by `clientId` + `subscriptionId`. `watch_values` MUST always delete the subscription in `finally`.
- **Unit discovery is best-effort**. We check `unit`, `units`, `engineeringUnit`, `engineeringUnits`, `unitOfMeasure`, `uom`, `x-i3x-unit`. Implementations that bury units elsewhere may need an addition to `src/units.ts:UNIT_KEYS`.
- **Catalog is per-connection**. Reconnecting to a different i3X server throws out the old catalog; tools always read from the current `ConnectionState`.

## Testing

No automated test suite yet. `smoke-test.mjs` spawns the server and walks through `connect` → `search_objects` → `get_object` → `read_current_value` → `get_history` → `find_related` → `refresh_catalog` against the public demo at `https://api.i3x.dev/v1`. Run with `node smoke-test.mjs` after any non-trivial change.

If you add a new tool, extend the smoke test.

## Release / publish

The `release:patch|minor|major` npm scripts bump version, build (via `prepublishOnly`), and publish to npm. Push tags after with `git push --follow-tags`. See README's "For developers" section for the workflow.

## Reference

- **i3X 1.0 implementation guide**: https://raw.githubusercontent.com/cesmii/i3X/refs/heads/1.0/spec/IMPLEMENTATION_GUIDE.md
- **Live demo (no auth)**: https://api.i3x.dev/v1
- **i3X spec repo**: https://github.com/cesmii/i3X
- **MCP spec**: https://modelcontextprotocol.io
