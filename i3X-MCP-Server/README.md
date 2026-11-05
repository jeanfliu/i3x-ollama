# i3x-mcp

A bridge that lets [Claude](https://claude.ai) (and any other MCP client) talk to your manufacturing data through the [i3X](https://github.com/cesmii/i3X) standard — so you can ask plain-English questions about your plant and get real answers.

> *"What equipment is on the production line?"*
> *"What's the current state of pump-101?"*
> *"Show me the temperature trend for tank-201 over the last hour."*
> *"What feeds into the assembly line?"*

---

## Install (5 minutes, no coding required)

### 1. Install Node.js (if you don't already have it)

Open a terminal and run:

```bash
node --version
```

If you see a version number ≥ 18 (e.g. `v20.0.0`), you're set. If not, download and install from [nodejs.org](https://nodejs.org/) — pick the "LTS" version.

### 2. Open Claude Desktop's config file

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

If the file doesn't exist, create it.

### 3. Add the `i3x` server

If the file is empty, paste this whole thing:

```json
{
  "mcpServers": {
    "i3x": {
      "command": "npx",
      "args": ["-y", "i3x-mcp@latest"]
    }
  }
}
```

If the file already has stuff in it, add only the `"i3x": { ... }` block inside `mcpServers` (and add the `mcpServers` block if missing). **Mind the commas** between JSON keys — that's the #1 reason Claude Desktop reports an invalid config.

### 4. Restart Claude Desktop

Fully quit (⌘Q on Mac, right-click tray → Quit on Windows) and reopen. The first time you use it, `npx` downloads `i3x-mcp` from npm — takes 10-20 seconds.

### 5. Tell Claude which i3X server to talk to

Start a new chat and say:

> *"Use the i3x `connect` tool with baseUrl `https://api.i3x.dev/v1`"*

(That's the public CESMII demo server. For your own deployment, substitute your URL.)

Claude will verify the connection and confirm. From there you can ask normal questions:

> *"What equipment is at the top of the hierarchy?"*
> *"Find anything with 'pump' in the name."*
> *"What's the current value of pump-101 and its components?"*
> *"Get the last hour of history for pump-101-state, averaged every 5 minutes."*

---

## Connecting to a private / authenticated server

If your i3X server requires authentication:

> *"Connect i3x to `https://i3x.mycompany.com/v1` with authScheme `bearer` and token `eyJhbGc...`"*

Supported auth schemes:
- `none` (default)
- `bearer` — uses `Authorization: Bearer <token>`
- `apikey` — uses a custom header (default `X-API-Key`, override with the `apiKeyHeader` argument)

Connections live for the duration of a Claude Desktop session. To switch servers mid-session, just call `connect` again.

### Persisting connection info via environment variables

If you'd rather not type the connect command each time, pre-set the connection in your Claude Desktop config:

```json
{
  "mcpServers": {
    "i3x": {
      "command": "npx",
      "args": ["-y", "i3x-mcp@latest"],
      "env": {
        "I3X_BASE_URL": "https://i3x.mycompany.com/v1",
        "I3X_AUTH_SCHEME": "bearer",
        "I3X_TOKEN": "eyJhbGc..."
      }
    }
  }
}
```

---

## What Claude can do

| Tool | What it does |
|---|---|
| `connect` | Point the server at an i3X instance. Validates against `/info`. |
| `connection_status` | Show current baseUrl, auth, and catalog state. |
| `server_info` | Capabilities of the connected i3X server (query/update/subscribe). |
| `search_objects` | Find equipment by name (fuzzy/substring). The main "where is X" tool. |
| `list_root_objects` | Top of the equipment hierarchy. |
| `refresh_catalog` | Re-fetch the object list after new equipment is added. |
| `get_object` | Detailed info on one or more objects (type, parent, relationships). |
| `read_current_value` | Latest value + quality + timestamp, with engineering units when known. |
| `get_history` | Time-range history with optional `avg`/`min`/`max`/`count` aggregation and `bucket` (e.g. `5m`). Accepts relative times like `"last 1h"`. |
| `find_related` | Graph traversal. Returns related objects grouped by relationship. |
| `describe_type` | ObjectType schema + per-field units (helps Claude interpret raw values). |
| `watch_values` | Bounded live-data window. Internally manages an i3X subscription. |

Writes (`update_value`, `write_history`) are **off by default**. See "Enabling writes" below.

---

## Time inputs

Anywhere a time is accepted (`get_history`), you can use:

- RFC 3339: `2026-06-12T10:00:00Z`
- Relative: `1h`, `30m`, `7d`, `last 30m`
- Keywords: `now`, `today`, `yesterday`

For `startTime`, a bare duration means "that long ago." For `endTime`, the default is `now`.

---

## Enabling writes (advanced)

Setpoint writes can affect live equipment. Writes are off by default. To enable them, modify your Claude Desktop config to pass `--enable-writes`:

```json
"args": ["-y", "i3x-mcp@latest", "--enable-writes"]
```

This exposes `update_value` and `write_history`. Both are marked as destructive — Claude will request explicit confirmation before invoking them.

---

## Tuning (environment variables)

| Env var | Default | Purpose |
|---|---|---|
| `I3X_BASE_URL` | unset | Optional pre-set baseUrl. If unset, use the `connect` tool from chat. |
| `I3X_AUTH_SCHEME` | `none` | `none`, `bearer`, or `apikey`. |
| `I3X_TOKEN` | — | Required when `I3X_AUTH_SCHEME` is `bearer` or `apikey`. |
| `I3X_APIKEY_HEADER` | `X-API-Key` | Header name used when `I3X_AUTH_SCHEME=apikey`. |
| `I3X_WATCH_MAX_SEC` | `300` | Hard cap on `watch_values` duration. |
| `I3X_RAW_HISTORY_MAX_POINTS` | `500` | Cap on raw VQT points returned per element by `get_history`. |

---

## Troubleshooting

**Claude Desktop says "MCP i3x: Server disconnected"**
- Check the `claude_desktop_config.json` is valid JSON (commas, braces).
- Confirm Node.js 18+ is installed and `node` is on your PATH.
- Open the developer logs in Claude Desktop's "Settings → Developer" panel for details.

**Tools return "Not connected to an i3X server"**
- Call the `connect` tool: *"Connect i3x to https://..."*
- Or set `I3X_BASE_URL` in the config's `env` block and restart Desktop.

**Connection fails on `connect`**
- The error message will say what failed (e.g. DNS, 401 Unauthorized). Re-check the baseUrl and auth.
- The `baseUrl` must include the version path, e.g. `https://api.i3x.dev/v1`.

---

## For developers

### Run from source

```bash
git clone <this-repo> i3x-mcp
cd i3x-mcp
npm install
npm run build
```

Point Claude Desktop at the local build:

```json
{
  "mcpServers": {
    "i3x": {
      "command": "node",
      "args": ["/absolute/path/to/i3x-mcp/dist/index.js"]
    }
  }
}
```

### Project layout

```
src/
  config.ts          # env + CLI parsing
  connection.ts      # connection lifecycle (connect / disconnect / state)
  i3x-client.ts      # HTTP client + i3X types
  catalog.ts         # cached object/type index + fuzzy search (fuse.js)
  time.ts            # relative time parsing
  aggregation.ts     # raw/avg/min/max/count bucketing
  units.ts           # unit extraction + value enrichment
  tools.ts           # all MCP tool registrations
  index.ts           # entry point
```

### Smoke test

```bash
node smoke-test.mjs
```

Spawns the server, walks through `connect` → `search_objects` → `get_history` against the public demo.

### Publishing to npm

You'll need an npm account with publish rights to `i3x-mcp`. Then:

```bash
# Patch release (0.1.0 → 0.1.1):
npm run release:patch

# Minor release (0.1.0 → 0.2.0):
npm run release:minor

# Major release (0.1.0 → 1.0.0):
npm run release:major
```

Each script:
1. Bumps `version` in `package.json`.
2. Creates a git commit and tag.
3. Runs `prepublishOnly` (which builds via `tsc`).
4. Publishes to the public npm registry.

Push the tag after with `git push --follow-tags`.

---

## License

MIT — see [LICENSE](LICENSE).
