import Fuse from "fuse.js";
import type { I3xClient, ObjectInstance, ObjectType, RelationshipType } from "./i3x-client.js";

export interface CatalogObjectEntry {
  elementId: string;
  displayName: string;
  typeElementId: string;
  typeDisplayName?: string;
  parentId?: string | null;
  parentPath?: string;
  isComposition?: boolean;
}

export interface CatalogSnapshot {
  builtAt: string;
  objectCount: number;
  typeCount: number;
  relationshipTypeCount: number;
}

export class Catalog {
  private objects: Map<string, ObjectInstance> = new Map();
  private types: Map<string, ObjectType> = new Map();
  private relTypes: Map<string, RelationshipType> = new Map();
  private entries: CatalogObjectEntry[] = [];
  private fuse: Fuse<CatalogObjectEntry> | null = null;
  private builtAt: string | null = null;
  private buildPromise: Promise<void> | null = null;

  constructor(private readonly client: I3xClient) {}

  ready(): Promise<void> {
    if (this.builtAt) return Promise.resolve();
    if (!this.buildPromise) this.buildPromise = this.build();
    return this.buildPromise;
  }

  async refresh(): Promise<CatalogSnapshot> {
    this.buildPromise = this.build();
    await this.buildPromise;
    return this.snapshot();
  }

  snapshot(): CatalogSnapshot {
    return {
      builtAt: this.builtAt ?? "never",
      objectCount: this.objects.size,
      typeCount: this.types.size,
      relationshipTypeCount: this.relTypes.size,
    };
  }

  getObject(elementId: string): ObjectInstance | undefined {
    return this.objects.get(elementId);
  }

  getType(typeElementId: string): ObjectType | undefined {
    return this.types.get(typeElementId);
  }

  getRelationshipType(elementId: string): RelationshipType | undefined {
    return this.relTypes.get(elementId);
  }

  allTypes(): ObjectType[] {
    return Array.from(this.types.values());
  }

  allRelationshipTypes(): RelationshipType[] {
    return Array.from(this.relTypes.values());
  }

  search(query: string, opts: { typeFilter?: string; limit?: number } = {}): CatalogObjectEntry[] {
    const limit = opts.limit ?? 25;
    let pool = this.entries;
    if (opts.typeFilter) {
      const tf = opts.typeFilter.toLowerCase();
      pool = pool.filter(e =>
        e.typeElementId.toLowerCase() === tf ||
        (e.typeDisplayName ?? "").toLowerCase() === tf ||
        e.typeElementId.toLowerCase().includes(tf) ||
        (e.typeDisplayName ?? "").toLowerCase().includes(tf)
      );
    }
    if (!query || !query.trim()) return pool.slice(0, limit);
    if (this.fuse) {
      const results = this.fuse.search(query, { limit: limit * 3 });
      const filtered = results
        .map(r => r.item)
        .filter(item => pool.includes(item))
        .slice(0, limit);
      if (filtered.length > 0) return filtered;
    }
    const q = query.toLowerCase();
    return pool
      .filter(e =>
        e.displayName.toLowerCase().includes(q) ||
        e.elementId.toLowerCase().includes(q) ||
        (e.parentPath ?? "").toLowerCase().includes(q)
      )
      .slice(0, limit);
  }

  private async build(): Promise<void> {
    const [objsRes, typesRes, relsRes] = await Promise.all([
      this.client.getObjects({ includeMetadata: true }),
      this.client.getObjectTypes(),
      this.client.getRelationshipTypes(),
    ]);

    this.objects.clear();
    this.types.clear();
    this.relTypes.clear();

    for (const t of typesRes.result ?? []) this.types.set(t.elementId, t);
    for (const r of relsRes.result ?? []) this.relTypes.set(r.elementId, r);
    for (const o of objsRes.result ?? []) this.objects.set(o.elementId, o);

    this.entries = Array.from(this.objects.values()).map(o => {
      const type = this.types.get(o.typeElementId);
      return {
        elementId: o.elementId,
        displayName: o.displayName,
        typeElementId: o.typeElementId,
        typeDisplayName: type?.displayName,
        parentId: o.parentId ?? null,
        parentPath: this.computeParentPath(o.elementId),
        isComposition: o.isComposition,
      };
    });

    this.fuse = new Fuse(this.entries, {
      keys: [
        { name: "displayName", weight: 0.6 },
        { name: "elementId", weight: 0.2 },
        { name: "typeDisplayName", weight: 0.1 },
        { name: "parentPath", weight: 0.1 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      includeScore: false,
    });

    this.builtAt = new Date().toISOString();
  }

  private computeParentPath(elementId: string): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current = this.objects.get(elementId)?.parentId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = this.objects.get(current);
      if (!parent) break;
      parts.unshift(parent.displayName);
      current = parent.parentId ?? undefined;
    }
    return parts.join(" / ");
  }
}
