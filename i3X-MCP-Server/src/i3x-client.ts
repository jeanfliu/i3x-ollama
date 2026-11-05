import type { Config } from "./config.js";

export type Quality = "Good" | "GoodNoData" | "Bad" | "Uncertain";

export interface VQT {
  value: unknown;
  quality: Quality;
  timestamp: string;
}

export interface Namespace {
  uri: string;
  displayName: string;
}

export interface ObjectType {
  elementId: string;
  displayName: string;
  namespaceUri: string;
  sourceTypeId?: string;
  version?: string;
  schema?: Record<string, unknown>;
  related?: Record<string, unknown>;
}

export interface ObjectInstanceMetadata {
  typeNamespaceUri?: string;
  sourceTypeId?: string;
  description?: string;
  relationships?: Record<string, string[]>;
  schemaExtensions?: Record<string, unknown>;
  system?: Record<string, unknown>;
}

export interface ObjectInstance {
  elementId: string;
  displayName: string;
  typeElementId: string;
  parentId?: string | null;
  isComposition?: boolean;
  isExtended?: boolean;
  metadata?: ObjectInstanceMetadata;
}

export interface RelationshipType {
  elementId: string;
  displayName: string;
  namespaceUri: string;
  relationshipId?: string;
  reverseOf?: string;
}

export interface RelatedObjectResult {
  sourceRelationship: string;
  object: ObjectInstance;
}

export interface CurrentValueResult {
  isComposition?: boolean;
  value: unknown;
  quality: Quality;
  timestamp: string;
  components?: Record<string, CurrentValueResult>;
}

export interface HistoricalValueResult {
  isComposition?: boolean;
  values: VQT[];
}

export interface ServerInfo {
  specVersion?: string;
  serverVersion?: string;
  serverName?: string;
  capabilities?: {
    query?: Record<string, boolean>;
    update?: Record<string, boolean>;
    subscribe?: Record<string, boolean>;
  };
}

export interface BulkResultItem<T> {
  success: boolean;
  elementId: string;
  result?: T;
  responseDetail?: { title?: string; status?: number; detail?: string };
}

export interface BulkResponse<T> {
  success: boolean;
  results: BulkResultItem<T>[];
}

export interface SuccessResponse<T> {
  success: boolean;
  result: T;
}

export interface CreateSubscriptionResponse {
  clientId: string;
  subscriptionId: string;
  displayName?: string;
}

export interface SyncUpdateEntry {
  elementId: string;
  value: unknown;
  quality: Quality;
  timestamp: string;
}

export interface SyncBatch {
  sequenceNumber: number;
  updates: SyncUpdateEntry[];
}

export class I3xClient {
  constructor(private readonly cfg: Config) {}

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Accept": "application/json" };
    if (this.cfg.authScheme === "bearer" && this.cfg.token) {
      h["Authorization"] = `Bearer ${this.cfg.token}`;
    } else if (this.cfg.authScheme === "apikey" && this.cfg.token) {
      h[this.cfg.apiKeyHeader] = this.cfg.token;
    }
    return h;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: { query?: Record<string, string | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.cfg.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers = this.buildHeaders();
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    if (!res.ok && res.status !== 206) {
      throw new Error(`i3X ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`i3X ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  // -- Info --
  getInfo() {
    return this.request<SuccessResponse<ServerInfo>>("GET", "/info");
  }

  // -- Explore --
  getNamespaces() {
    return this.request<SuccessResponse<Namespace[]>>("GET", "/namespaces");
  }
  getObjectTypes(namespaceUri?: string) {
    return this.request<SuccessResponse<ObjectType[]>>("GET", "/objecttypes", { query: { namespaceUri } });
  }
  queryObjectTypes(elementIds: string[]) {
    return this.request<BulkResponse<ObjectType>>("POST", "/objecttypes/query", { body: { elementIds } });
  }
  getRelationshipTypes(namespaceUri?: string) {
    return this.request<SuccessResponse<RelationshipType[]>>("GET", "/relationshiptypes", { query: { namespaceUri } });
  }
  getObjects(opts: { typeElementId?: string; includeMetadata?: boolean; root?: boolean } = {}) {
    return this.request<SuccessResponse<ObjectInstance[]>>("GET", "/objects", { query: opts });
  }
  listObjects(elementIds: string[], includeMetadata = false) {
    return this.request<BulkResponse<ObjectInstance>>("POST", "/objects/list", {
      body: { elementIds, includeMetadata },
    });
  }
  relatedObjects(elementIds: string[], relationshipType?: string, includeMetadata = false) {
    return this.request<BulkResponse<RelatedObjectResult[]>>("POST", "/objects/related", {
      body: { elementIds, relationshipType, includeMetadata },
    });
  }

  // -- Query --
  getCurrentValues(elementIds: string[], maxDepth = 1) {
    return this.request<BulkResponse<CurrentValueResult>>("POST", "/objects/value", {
      body: { elementIds, maxDepth },
    });
  }
  getHistory(elementIds: string[], startTime: string, endTime: string, maxDepth = 1) {
    return this.request<BulkResponse<HistoricalValueResult>>("POST", "/objects/history", {
      body: { elementIds, startTime, endTime, maxDepth },
    });
  }

  // -- Update --
  updateValues(updates: Array<{ elementId: string; value: VQT | { value: unknown; quality?: Quality; timestamp?: string } }>) {
    return this.request<BulkResponse<null>>("PUT", "/objects/value", { body: { updates } });
  }
  updateHistory(updates: Array<{ elementId: string; value: VQT }>) {
    return this.request<BulkResponse<null>>("PUT", "/objects/history", { body: { updates } });
  }

  // -- Subscriptions --
  createSubscription(clientId: string, displayName?: string) {
    return this.request<SuccessResponse<CreateSubscriptionResponse>>("POST", "/subscriptions", {
      body: { clientId, displayName },
    });
  }
  registerMonitored(clientId: string, subscriptionId: string, elementIds: string[], maxDepth = 1) {
    return this.request<BulkResponse<null>>("POST", "/subscriptions/register", {
      body: { clientId, subscriptionId, elementIds, maxDepth },
    });
  }
  syncSubscription(clientId: string, subscriptionId: string, lastSequenceNumber?: number) {
    return this.request<SuccessResponse<SyncBatch[]>>("POST", "/subscriptions/sync", {
      body: { clientId, subscriptionId, lastSequenceNumber },
    });
  }
  deleteSubscriptions(clientId: string, subscriptionIds: string[]) {
    return this.request<BulkResponse<null>>("POST", "/subscriptions/delete", {
      body: { clientId, subscriptionIds },
    });
  }
}
