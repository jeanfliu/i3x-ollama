import type { ConnectionInput, RuntimeOptions } from "./connection.js";

export interface Config {
  baseUrl: string;
  authScheme: "none" | "bearer" | "apikey";
  token: string | undefined;
  apiKeyHeader: string;
  enableWrites: boolean;
  watchMaxDurationSec: number;
  rawHistoryMaxPoints: number;
}

export interface LoadedConfig {
  runtime: RuntimeOptions;
  initialConnection: ConnectionInput | null;
}

export function loadConfig(argv: string[]): LoadedConfig {
  const runtime: RuntimeOptions = {
    enableWrites: argv.includes("--enable-writes"),
    watchMaxDurationSec: Number(process.env.I3X_WATCH_MAX_SEC ?? 300),
    rawHistoryMaxPoints: Number(process.env.I3X_RAW_HISTORY_MAX_POINTS ?? 500),
  };

  const baseUrl = process.env.I3X_BASE_URL;
  if (!baseUrl) {
    return { runtime, initialConnection: null };
  }

  const scheme = (process.env.I3X_AUTH_SCHEME ?? "none").toLowerCase();
  if (scheme !== "none" && scheme !== "bearer" && scheme !== "apikey") {
    throw new Error(`I3X_AUTH_SCHEME must be one of: none, bearer, apikey (got "${scheme}")`);
  }
  const token = process.env.I3X_TOKEN;
  if ((scheme === "bearer" || scheme === "apikey") && !token) {
    throw new Error(`I3X_AUTH_SCHEME=${scheme} requires I3X_TOKEN to be set`);
  }

  return {
    runtime,
    initialConnection: {
      baseUrl,
      authScheme: scheme,
      token,
      apiKeyHeader: process.env.I3X_APIKEY_HEADER ?? "X-API-Key",
    },
  };
}
