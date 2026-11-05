#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ConnectionManager } from "./connection.js";
import { registerTools } from "./tools.js";

async function main() {
  const { runtime, initialConnection } = loadConfig(process.argv);
  const connection = new ConnectionManager(runtime);

  const server = new McpServer({ name: "i3x-mcp", version: "0.1.0" });
  registerTools(server, { connection, runtime });

  if (initialConnection) {
    try {
      await connection.connect(initialConnection);
      console.error(
        `[i3x-mcp] pre-connected from env. baseUrl=${initialConnection.baseUrl} writes=${runtime.enableWrites ? "enabled" : "disabled"}`,
      );
    } catch (e) {
      console.error(`[i3x-mcp] env-supplied connection failed: ${e instanceof Error ? e.message : e}`);
      console.error(`[i3x-mcp] use the 'connect' tool to set a working baseUrl.`);
    }
  } else {
    console.error(`[i3x-mcp] no I3X_BASE_URL — use the 'connect' tool to set baseUrl.`);
  }

  await server.connect(new StdioServerTransport());
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
