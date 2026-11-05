import type { VQT } from "./i3x-client.js";
import { parseDurationMs } from "./time.js";

export type Aggregation = "raw" | "avg" | "min" | "max" | "count";

export interface Bucket {
  bucketStart: string;
  bucketEnd: string;
  count: number;
  goodCount: number;
  value: number | null; // null when no good numeric data in bucket
}

export interface AggregateResult {
  aggregation: Aggregation;
  bucket?: string;
  totalPoints: number;
  truncated?: boolean;
  raw?: VQT[];
  buckets?: Bucket[];
  summary?: { value: number | null; goodCount: number };
}

function numericVQT(v: VQT): number | null {
  if (v.quality === "Bad" || v.quality === "GoodNoData") return null;
  if (typeof v.value === "number" && isFinite(v.value)) return v.value;
  if (typeof v.value === "boolean") return v.value ? 1 : 0;
  return null;
}

export function aggregate(
  values: VQT[],
  aggregation: Aggregation,
  bucket: string | undefined,
  startTime: Date,
  endTime: Date,
  rawMaxPoints: number,
): AggregateResult {
  if (aggregation === "raw") {
    const truncated = values.length > rawMaxPoints;
    return {
      aggregation: "raw",
      totalPoints: values.length,
      truncated,
      raw: truncated ? values.slice(values.length - rawMaxPoints) : values,
    };
  }

  if (!bucket) {
    // single-bucket overall summary
    const stats = reduceWindow(values, aggregation);
    return {
      aggregation,
      totalPoints: values.length,
      summary: stats,
    };
  }

  const bucketMs = parseDurationMs(bucket);
  if (bucketMs === null || bucketMs <= 0) {
    throw new Error(`Invalid bucket "${bucket}". Use forms like "30s", "5m", "1h", "1d".`);
  }

  const startMs = startTime.getTime();
  const endMs = endTime.getTime();
  const numBuckets = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));
  const grouped: VQT[][] = Array.from({ length: numBuckets }, () => []);

  for (const v of values) {
    const t = new Date(v.timestamp).getTime();
    if (isNaN(t)) continue;
    if (t < startMs || t >= endMs) continue;
    const idx = Math.min(numBuckets - 1, Math.floor((t - startMs) / bucketMs));
    grouped[idx].push(v);
  }

  const buckets: Bucket[] = grouped.map((window, i) => {
    const bStart = new Date(startMs + i * bucketMs);
    const bEnd = new Date(Math.min(endMs, startMs + (i + 1) * bucketMs));
    const { value, goodCount } = reduceWindow(window, aggregation);
    return {
      bucketStart: bStart.toISOString(),
      bucketEnd: bEnd.toISOString(),
      count: window.length,
      goodCount,
      value,
    };
  });

  return { aggregation, bucket, totalPoints: values.length, buckets };
}

function reduceWindow(window: VQT[], aggregation: Aggregation): { value: number | null; goodCount: number } {
  if (aggregation === "count") {
    return { value: window.length, goodCount: window.filter(v => v.quality === "Good").length };
  }
  const nums: number[] = [];
  for (const v of window) {
    const n = numericVQT(v);
    if (n !== null) nums.push(n);
  }
  if (nums.length === 0) return { value: null, goodCount: 0 };
  let v: number;
  if (aggregation === "avg") v = nums.reduce((a, b) => a + b, 0) / nums.length;
  else if (aggregation === "min") v = Math.min(...nums);
  else if (aggregation === "max") v = Math.max(...nums);
  else v = nums.length;
  return { value: v, goodCount: nums.length };
}
