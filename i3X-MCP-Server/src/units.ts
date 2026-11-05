import type { ObjectType } from "./i3x-client.js";

const UNIT_KEYS = ["unit", "units", "engineeringUnit", "engineeringUnits", "unitOfMeasure", "uom", "x-i3x-unit"];

function pickUnit(schema: Record<string, unknown> | undefined): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  for (const k of UNIT_KEYS) {
    const v = (schema as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).displayName === "string") {
      return (v as { displayName: string }).displayName;
    }
  }
  return undefined;
}

/**
 * Walk an ObjectType's JSON Schema and produce a path -> unit map.
 *   - "" maps to the scalar unit (when the schema itself is a scalar leaf)
 *   - "field" maps to a top-level property's unit
 *   - "field.subfield" for nested objects (1 level deep is enough for v1)
 */
export function extractUnitMap(type: ObjectType | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const schema = type?.schema;
  if (!schema) return out;

  const rootUnit = pickUnit(schema);
  if (rootUnit) out[""] = rootUnit;

  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (props && typeof props === "object") {
    for (const [name, def] of Object.entries(props)) {
      if (!def || typeof def !== "object") continue;
      const u = pickUnit(def as Record<string, unknown>);
      if (u) out[name] = u;
      const sub = (def as { properties?: Record<string, unknown> }).properties;
      if (sub && typeof sub === "object") {
        for (const [subName, subDef] of Object.entries(sub)) {
          if (!subDef || typeof subDef !== "object") continue;
          const su = pickUnit(subDef as Record<string, unknown>);
          if (su) out[`${name}.${subName}`] = su;
        }
      }
    }
  }
  return out;
}

/**
 * Attach unit annotations to a value payload using the unit map.
 * - Scalar leaf values: returns { value, unit, quality, timestamp }
 * - Object values: returns the original value with a parallel "_units" map of field -> unit
 */
export function enrichValueWithUnits<T extends { value: unknown; quality: string; timestamp: string }>(
  payload: T,
  unitMap: Record<string, string>,
): T & { unit?: string; _units?: Record<string, string> } {
  if (payload.value !== null && typeof payload.value === "object" && !Array.isArray(payload.value)) {
    const units: Record<string, string> = {};
    for (const k of Object.keys(payload.value as Record<string, unknown>)) {
      if (unitMap[k]) units[k] = unitMap[k];
    }
    return Object.keys(units).length > 0 ? { ...payload, _units: units } : payload;
  }
  const rootUnit = unitMap[""];
  return rootUnit ? { ...payload, unit: rootUnit } : payload;
}
