import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager, ConnectionState, RuntimeOptions } from "./connection.js";
import type { Catalog } from "./catalog.js";
import type { BulkResultItem, CurrentValueResult, ObjectInstance } from "./i3x-client.js";
import { aggregate, type Aggregation } from "./aggregation.js";
import { parseTimeInput, toRfc3339 } from "./time.js";
import { enrichValueWithUnits, extractUnitMap } from "./units.js";

interface ToolDeps {
  connection: ConnectionManager;
  runtime: RuntimeOptions;
}

function asText(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorText(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

function notConnected() {
  return errorText(
    "Not connected to an i3X server. Call the `connect` tool first.\n\n" +
      'Example: connect with baseUrl="https://api.i3x.dev/v1" (public demo, no auth).\n' +
      'For auth-required servers, also pass authScheme="bearer" or "apikey" and a token.',
  );
}

function summarizeObject(o: ObjectInstance, catalog: Catalog) {
  const type = catalog.getType(o.typeElementId);
  return {
    elementId: o.elementId,
    displayName: o.displayName,
    type: { elementId: o.typeElementId, displayName: type?.displayName },
    parentId: o.parentId ?? null,
    isComposition: o.isComposition ?? false,
    isExtended: o.isExtended ?? false,
    description: o.metadata?.description,
  };
}

function enrichCurrentValue(elementId: string, result: CurrentValueResult, catalog: Catalog): Record<string, unknown> {
  const obj = catalog.getObject(elementId);
  const type = obj ? catalog.getType(obj.typeElementId) : undefined;
  const unitMap = extractUnitMap(type);
  const base = enrichValueWithUnits(
    { value: result.value, quality: result.quality, timestamp: result.timestamp },
    unitMap,
  );
  const out: Record<string, unknown> = { elementId, displayName: obj?.displayName, ...base };
  if (result.isComposition) out.isComposition = true;
  if (result.components) {
    out.components = Object.fromEntries(
      Object.entries(result.components).map(([k, v]) => [k, enrichCurrentValueShallow(v, unitMap[k])]),
    );
  }
  return out;
}

function enrichCurrentValueShallow(result: CurrentValueResult, unit: string | undefined) {
  const base: Record<string, unknown> = { value: result.value, quality: result.quality, timestamp: result.timestamp };
  if (unit) base.unit = unit;
  if (result.components) {
    base.components = Object.fromEntries(
      Object.entries(result.components).map(([k, v]) => [k, enrichCurrentValueShallow(v, undefined)]),
    );
  }
  return base;
}

function formatBulkResults<T>(results: BulkResultItem<T>[]) {
  return results.map(r => {
    if (r.success) return { elementId: r.elementId, success: true, result: r.result };
    return {
      elementId: r.elementId,
      success: false,
      error: r.responseDetail?.title ?? "Request failed",
      detail: r.responseDetail?.detail,
    };
  });
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerConnect(server, deps);
  registerConnectionStatus(server, deps);
  registerInfo(server, deps);
  registerSearch(server, deps);
  registerListRoot(server, deps);
  registerRefresh(server, deps);
  registerGetObject(server, deps);
  registerReadCurrent(server, deps);
  registerHistory(server, deps);
  registerRelated(server, deps);
  registerDescribeType(server, deps);
  registerWatch(server, deps);
  if (deps.runtime.enableWrites) {
    registerUpdateValue(server, deps);
    registerWriteHistory(server, deps);
  }
}

// connect (always available)
function registerConnect(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "connect",
    {
      title: "Connect to an i3X server",
      description:
        "Point the MCP server at an i3X instance. Required before any data tool will work (unless I3X_BASE_URL was set in the env). " +
        "Validates by calling /info on the target. Switching connections at any time is fine — call this again.",
      inputSchema: {
        baseUrl: z.string().describe("Versioned base URL, e.g. https://api.i3x.dev/v1"),
        authScheme: z.enum(["none", "bearer", "apikey"]).optional().describe('Default "none".'),
        token: z.string().optional().describe('Required when authScheme is "bearer" or "apikey".'),
        apiKeyHeader: z.string().optional().describe('Header name for apikey auth (default "X-API-Key").'),
      },
    },
    async ({ baseUrl, authScheme, token, apiKeyHeader }) => {
      try {
        const result = await connection.connect({ baseUrl, authScheme, token, apiKeyHeader });
        return asText({ status: "connected", ...result });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerConnectionStatus(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "connection_status",
    {
      title: "Show current i3X connection",
      description: "Returns whether an i3X connection is active, the baseUrl, auth scheme, and catalog snapshot.",
      inputSchema: {},
    },
    async () => asText(connection.describe()),
  );
}

// server_info — i3X server capabilities
function registerInfo(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "server_info",
    {
      title: "i3X server info",
      description:
        "Returns the i3X server's capabilities, version, and supported features (query/update/subscribe).",
      inputSchema: {},
    },
    async () => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        const res = await state.client.getInfo();
        return asText(res.result);
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerSearch(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "search_objects",
    {
      title: "Search objects",
      description:
        "Fuzzy/substring search over the cached object catalog. Use this to find equipment, sensors, or processes by name. " +
        "Returns elementId, displayName, type, and parent path.",
      inputSchema: {
        query: z.string().describe("Search text."),
        typeFilter: z.string().optional().describe("Optional: restrict to a specific ObjectType displayName or elementId."),
        limit: z.number().int().positive().max(200).optional().describe("Max results (default 25)."),
      },
    },
    async ({ query, typeFilter, limit }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        await state.catalog.ready();
        const hits = state.catalog.search(query, { typeFilter, limit });
        return asText({ query, count: hits.length, results: hits });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerListRoot(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "list_root_objects",
    {
      title: "List root objects",
      description: "Returns top-level objects in the i3X hierarchy (no parent). Good entry point for unfamiliar plants.",
      inputSchema: {
        includeMetadata: z.boolean().optional().describe("Include descriptions and relationships (default false)."),
      },
    },
    async ({ includeMetadata }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        await state.catalog.ready();
        const res = await state.client.getObjects({ root: true, includeMetadata });
        const objs = (res.result ?? []).map(o => summarizeObject(o, state.catalog));
        return asText({ count: objs.length, results: objs });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerRefresh(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "refresh_catalog",
    {
      title: "Refresh catalog",
      description: "Rebuilds the local object/type catalog from the i3X server.",
      inputSchema: {},
    },
    async () => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        const snap = await state.catalog.refresh();
        return asText({ status: "ok", ...snap });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerGetObject(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "get_object",
    {
      title: "Get object details",
      description: "Detailed info for one or more objects: type, parent, composition flag, declared relationships.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1).describe("Element IDs to look up."),
        includeMetadata: z.boolean().optional().describe("Include descriptions and full relationship graph (default true)."),
      },
    },
    async ({ elementIds, includeMetadata = true }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        await state.catalog.ready();
        const res = await state.client.listObjects(elementIds, includeMetadata);
        const items = res.results.map(r => {
          if (!r.success || !r.result) return { elementId: r.elementId, success: false, error: r.responseDetail?.title };
          const o = r.result;
          const type = state.catalog.getType(o.typeElementId);
          return {
            elementId: o.elementId,
            displayName: o.displayName,
            type: { elementId: o.typeElementId, displayName: type?.displayName, namespaceUri: type?.namespaceUri },
            parentId: o.parentId ?? null,
            isComposition: o.isComposition ?? false,
            isExtended: o.isExtended ?? false,
            metadata: o.metadata,
          };
        });
        return asText({ count: items.length, results: items });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerReadCurrent(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "read_current_value",
    {
      title: "Read current value",
      description:
        "Latest value (with quality and timestamp) for one or more objects. Set maxDepth>1 to include composed sub-components. " +
        "Values are enriched with engineering units when the ObjectType schema declares them.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1).describe("Element IDs to read."),
        maxDepth: z.number().int().min(0).max(10).optional().describe("Composition depth. 1=this object only (default), 0=infinite, N=N levels."),
      },
    },
    async ({ elementIds, maxDepth }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        await state.catalog.ready();
        const res = await state.client.getCurrentValues(elementIds, maxDepth ?? 1);
        const items = res.results.map(r => {
          if (!r.success || !r.result) return { elementId: r.elementId, success: false, error: r.responseDetail?.title };
          return { success: true, ...enrichCurrentValue(r.elementId, r.result, state.catalog) };
        });
        return asText({ count: items.length, results: items });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerHistory(server: McpServer, { connection, runtime }: ToolDeps) {
  server.registerTool(
    "get_history",
    {
      title: "Get historical values",
      description:
        "Historical values over a time range with optional server-side aggregation. Times accept RFC 3339, relative durations ('1h', 'last 30m'), 'now', 'today', or 'yesterday'. " +
        "For long ranges use aggregation='avg'|'min'|'max'|'count' with a bucket like '5m' or '1h'.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1).describe("Element IDs."),
        startTime: z.string().describe("Start of range. RFC 3339 or relative duration."),
        endTime: z.string().optional().describe("End of range. Default 'now'."),
        aggregation: z.enum(["raw", "avg", "min", "max", "count"]).optional().describe("How to aggregate (default 'raw')."),
        bucket: z.string().optional().describe("Bucket interval, e.g. '30s', '5m', '1h'."),
        maxDepth: z.number().int().min(0).max(10).optional().describe("Composition depth (default 1)."),
      },
    },
    async ({ elementIds, startTime, endTime, aggregation, bucket, maxDepth }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        await state.catalog.ready();
        const now = new Date();
        const startDate = parseTimeInput(startTime, "start", now);
        const endDate = parseTimeInput(endTime ?? "now", "end", now);
        if (endDate.getTime() <= startDate.getTime()) {
          throw new Error(`endTime (${endDate.toISOString()}) must be after startTime (${startDate.toISOString()}).`);
        }
        const res = await state.client.getHistory(elementIds, toRfc3339(startDate), toRfc3339(endDate), maxDepth ?? 1);
        const agg: Aggregation = aggregation ?? "raw";
        const items = res.results.map(r => {
          if (!r.success || !r.result) return { elementId: r.elementId, success: false, error: r.responseDetail?.title };
          const obj = state.catalog.getObject(r.elementId);
          const type = obj ? state.catalog.getType(obj.typeElementId) : undefined;
          const unitMap = extractUnitMap(type);
          const summary = aggregate(r.result.values ?? [], agg, bucket, startDate, endDate, runtime.rawHistoryMaxPoints);
          return { elementId: r.elementId, displayName: obj?.displayName, unit: unitMap[""] ?? undefined, ...summary };
        });
        return asText({
          startTime: toRfc3339(startDate),
          endTime: toRfc3339(endDate),
          aggregation: agg,
          bucket,
          count: items.length,
          results: items,
        });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerRelated(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "find_related",
    {
      title: "Find related objects",
      description:
        "Objects related to the given ones via the i3X relationship graph. If relationshipType omitted, groups by type.",
      inputSchema: {
        elementIds: z.array(z.string()).min(1).describe("Start element IDs."),
        relationshipType: z.string().optional().describe("Optional: a RelationshipType elementId or displayName."),
        includeMetadata: z.boolean().optional().describe("Include descriptions (default false)."),
      },
    },
    async ({ elementIds, relationshipType, includeMetadata }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        await state.catalog.ready();
        let resolvedType = relationshipType;
        if (relationshipType) {
          const direct = state.catalog.getRelationshipType(relationshipType);
          if (!direct) {
            const match = state.catalog
              .allRelationshipTypes()
              .find(r => r.displayName.toLowerCase() === relationshipType.toLowerCase());
            if (match) resolvedType = match.elementId;
          }
        }
        const res = await state.client.relatedObjects(elementIds, resolvedType, includeMetadata ?? false);
        const items = res.results.map(r => {
          if (!r.success || !r.result) return { elementId: r.elementId, success: false, error: r.responseDetail?.title };
          const grouped: Record<string, ReturnType<typeof summarizeObject>[]> = {};
          for (const rel of r.result) {
            const relType = state.catalog.getRelationshipType(rel.sourceRelationship);
            const key = relType?.displayName ?? rel.sourceRelationship;
            (grouped[key] ??= []).push(summarizeObject(rel.object, state.catalog));
          }
          return { elementId: r.elementId, success: true, related: grouped };
        });
        return asText({ count: items.length, results: items });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerDescribeType(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "describe_type",
    {
      title: "Describe ObjectType",
      description: "Returns the JSON Schema and per-field units for an ObjectType.",
      inputSchema: {
        typeElementId: z.string().describe("ObjectType elementId."),
      },
    },
    async ({ typeElementId }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        await state.catalog.ready();
        let type = state.catalog.getType(typeElementId);
        if (!type) {
          const res = await state.client.queryObjectTypes([typeElementId]);
          const first = res.results.find(r => r.success && r.result);
          if (first?.result) type = first.result;
        }
        if (!type) return errorText(new Error(`ObjectType "${typeElementId}" not found.`));
        const unitMap = extractUnitMap(type);
        return asText({
          elementId: type.elementId,
          displayName: type.displayName,
          namespaceUri: type.namespaceUri,
          sourceTypeId: type.sourceTypeId,
          version: type.version,
          units: unitMap,
          schema: type.schema,
        });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerWatch(server: McpServer, { connection, runtime }: ToolDeps) {
  server.registerTool(
    "watch_values",
    {
      title: "Watch values for a bounded window",
      description: `Monitor one or more objects for live changes over a bounded duration (max ${runtime.watchMaxDurationSec}s). Creates an i3X subscription internally and cleans it up on exit. Returns per-element summary of all observed changes (count, first, last, min, max).`,
      inputSchema: {
        elementIds: z.array(z.string()).min(1).describe("Element IDs to monitor."),
        durationSeconds: z.number().int().positive().describe(`How long to watch. Capped at ${runtime.watchMaxDurationSec}s.`),
        pollIntervalSeconds: z.number().int().positive().max(60).optional().describe("Poll interval (default 2s)."),
      },
    },
    async ({ elementIds, durationSeconds, pollIntervalSeconds }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      const duration = Math.min(durationSeconds, runtime.watchMaxDurationSec);
      const interval = (pollIntervalSeconds ?? 2) * 1000;
      const clientId = `i3x-mcp-${randomUUID()}`;
      let subscriptionId: string | null = null;
      const observed = new Map<string, { count: number; first?: unknown; last?: unknown; min?: number; max?: number; lastTs?: string }>();
      try {
        await state.catalog.ready();
        const created = await state.client.createSubscription(clientId, "i3x-mcp watch");
        subscriptionId = created.result.subscriptionId;
        await state.client.registerMonitored(clientId, subscriptionId, elementIds);

        const deadline = Date.now() + duration * 1000;
        let lastSeq: number | undefined;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          await new Promise(res => setTimeout(res, Math.min(interval, remaining)));
          const batchRes = await state.client.syncSubscription(clientId, subscriptionId, lastSeq);
          const batches = batchRes.result ?? [];
          for (const batch of batches) {
            lastSeq = batch.sequenceNumber;
            for (const u of batch.updates) {
              const entry = observed.get(u.elementId) ?? { count: 0 };
              entry.count++;
              if (entry.first === undefined) entry.first = u.value;
              entry.last = u.value;
              entry.lastTs = u.timestamp;
              if (typeof u.value === "number" && isFinite(u.value)) {
                if (entry.min === undefined || u.value < entry.min) entry.min = u.value;
                if (entry.max === undefined || u.value > entry.max) entry.max = u.value;
              }
              observed.set(u.elementId, entry);
            }
          }
        }

        const summary = elementIds.map(id => {
          const obj = state.catalog.getObject(id);
          const o = observed.get(id);
          return {
            elementId: id,
            displayName: obj?.displayName,
            observedUpdates: o?.count ?? 0,
            first: o?.first,
            last: o?.last,
            min: o?.min,
            max: o?.max,
            lastTimestamp: o?.lastTs,
          };
        });
        return asText({ durationSeconds: duration, results: summary });
      } catch (e) {
        return errorText(e);
      } finally {
        if (subscriptionId) {
          try {
            await state.client.deleteSubscriptions(clientId, [subscriptionId]);
          } catch {
            // best-effort cleanup
          }
        }
      }
    },
  );
}

function registerUpdateValue(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "update_value",
    {
      title: "Update current value (WRITE — live equipment)",
      description:
        "WRITES to the i3X server. Sets the current value (e.g. a setpoint). May change physical equipment behavior — confirm with a human first. Requires --enable-writes.",
      inputSchema: {
        updates: z
          .array(
            z.object({
              elementId: z.string(),
              value: z.unknown(),
              quality: z.enum(["Good", "GoodNoData", "Bad", "Uncertain"]).optional(),
              timestamp: z.string().optional(),
            }),
          )
          .min(1),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ updates }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        const wrapped = updates.map(u => ({
          elementId: u.elementId,
          value: { value: u.value, quality: u.quality, timestamp: u.timestamp },
        }));
        const res = await state.client.updateValues(wrapped);
        return asText({ results: formatBulkResults(res.results) });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}

function registerWriteHistory(server: McpServer, { connection }: ToolDeps) {
  server.registerTool(
    "write_history",
    {
      title: "Write historical value (WRITE — historian)",
      description:
        "WRITES to the i3X historian. Inserts a VQT record at a specified timestamp. For back-filling. Requires --enable-writes.",
      inputSchema: {
        updates: z
          .array(
            z.object({
              elementId: z.string(),
              value: z.unknown(),
              quality: z.enum(["Good", "GoodNoData", "Bad", "Uncertain"]),
              timestamp: z.string(),
            }),
          )
          .min(1),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ updates }) => {
      const state = connection.tryGet();
      if (!state) return notConnected();
      try {
        const wrapped = updates.map(u => ({
          elementId: u.elementId,
          value: { value: u.value, quality: u.quality, timestamp: u.timestamp },
        }));
        const res = await state.client.updateHistory(wrapped);
        return asText({ results: formatBulkResults(res.results) });
      } catch (e) {
        return errorText(e);
      }
    },
  );
}
