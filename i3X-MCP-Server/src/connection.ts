import { I3xClient } from "./i3x-client.js";
import { Catalog } from "./catalog.js";
import type { Config } from "./config.js";

export interface ConnectionInput {
  baseUrl: string;
  authScheme?: "none" | "bearer" | "apikey";
  token?: string;
  apiKeyHeader?: string;
}

export interface ConnectionState {
  client: I3xClient;
  catalog: Catalog;
  config: Config;
}

export interface RuntimeOptions {
  enableWrites: boolean;
  watchMaxDurationSec: number;
  rawHistoryMaxPoints: number;
}

export class ConnectionManager {
  private state: ConnectionState | null = null;

  constructor(private readonly runtime: RuntimeOptions) {}

  get connected(): boolean {
    return this.state !== null;
  }

  tryGet(): ConnectionState | null {
    return this.state;
  }

  describe() {
    if (!this.state) return { connected: false as const };
    return {
      connected: true as const,
      baseUrl: this.state.config.baseUrl,
      authScheme: this.state.config.authScheme,
      writesEnabled: this.state.config.enableWrites,
      catalog: this.state.catalog.snapshot(),
    };
  }

  async connect(input: ConnectionInput): Promise<{ baseUrl: string; serverInfo: unknown }> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("baseUrl is required.");
    const authScheme = input.authScheme ?? "none";
    if (authScheme !== "none" && authScheme !== "bearer" && authScheme !== "apikey") {
      throw new Error(`authScheme must be one of: none, bearer, apikey (got "${authScheme}")`);
    }
    if ((authScheme === "bearer" || authScheme === "apikey") && !input.token) {
      throw new Error(`authScheme="${authScheme}" requires a token.`);
    }

    const config: Config = {
      baseUrl,
      authScheme,
      token: input.token,
      apiKeyHeader: input.apiKeyHeader ?? "X-API-Key",
      enableWrites: this.runtime.enableWrites,
      watchMaxDurationSec: this.runtime.watchMaxDurationSec,
      rawHistoryMaxPoints: this.runtime.rawHistoryMaxPoints,
    };

    const client = new I3xClient(config);
    let info;
    try {
      info = await client.getInfo();
    } catch (e) {
      throw new Error(
        `Could not reach ${baseUrl}/info — ${e instanceof Error ? e.message : String(e)}. ` +
        `Check the URL and (if applicable) authScheme/token.`,
      );
    }

    const catalog = new Catalog(client);
    catalog.ready().catch(err => {
      console.error(`[i3x-mcp] catalog build failed: ${err instanceof Error ? err.message : err}`);
    });

    this.state = { client, catalog, config };
    return { baseUrl, serverInfo: info.result };
  }

  disconnect(): void {
    this.state = null;
  }
}
