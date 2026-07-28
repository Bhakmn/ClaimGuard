/**
 * Minimal in-process Prometheus text-format metrics registry.
 *
 * No external dependency — implements only the subset required by the spec:
 *  - Counter   : monotonically increasing, `.inc(labels, [n])`
 *  - Gauge     : arbitrary snapshot,       `.set(labels, n)`
 *  - Histogram : configurable buckets,     `.observe(labels, v)`
 *
 * All metric names must be valid Prometheus metric names (letters, digits, _).
 * `render()` returns the full text/plain; version=0.0.4 body.
 *
 * Thread-safety: Node.js is single-threaded; no locking required.
 */

/* ── Types ───────────────────────────────────────────────────────────────── */

export type Labels = Record<string, string | number | boolean>;

type MetricType = "counter" | "gauge" | "histogram";

/* ── Label serialisation ─────────────────────────────────────────────────── */

function serialiseLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const pairs = entries
    .map(([k, v]) => {
      const escaped = String(v)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
      return `${k}="${escaped}"`;
    })
    .join(",");
  return `{${pairs}}`;
}

/** Stable key from a labels object, sorted by key name. */
function labelsKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join(",");
}

/* ── Counter ─────────────────────────────────────────────────────────────── */

export class Counter {
  readonly name: string;
  readonly help: string;
  private readonly _values = new Map<string, number>();
  private readonly _labelMap = new Map<string, Labels>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, n = 1): void {
    const key = labelsKey(labels);
    this._values.set(key, (this._values.get(key) ?? 0) + n);
    this._labelMap.set(key, labels);
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this._values.size === 0) {
      lines.push(`${this.name}_total 0`);
    } else {
      for (const [key, val] of this._values) {
        const labels = this._labelMap.get(key) ?? {};
        lines.push(`${this.name}_total${serialiseLabels(labels)} ${val}`);
      }
    }
    return lines.join("\n");
  }
}

/* ── Gauge ───────────────────────────────────────────────────────────────── */

export class Gauge {
  readonly name: string;
  readonly help: string;
  private readonly _values = new Map<string, number>();
  private readonly _labelMap = new Map<string, Labels>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(labels: Labels = {}, value: number): void {
    const key = labelsKey(labels);
    this._values.set(key, value);
    this._labelMap.set(key, labels);
  }

  inc(labels: Labels = {}, n = 1): void {
    const key = labelsKey(labels);
    this._values.set(key, (this._values.get(key) ?? 0) + n);
    this._labelMap.set(key, labels);
  }

  dec(labels: Labels = {}, n = 1): void {
    this.inc(labels, -n);
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this._values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this._values) {
        const labels = this._labelMap.get(key) ?? {};
        lines.push(`${this.name}${serialiseLabels(labels)} ${val}`);
      }
    }
    return lines.join("\n");
  }
}

/* ── Histogram ───────────────────────────────────────────────────────────── */

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly _buckets: number[];
  // Map from label-key → { counts[], sum, count }
  private readonly _data = new Map<string, { buckets: number[]; sum: number; count: number }>();
  private readonly _labelMap = new Map<string, Labels>();

  constructor(name: string, help: string, buckets = DEFAULT_BUCKETS) {
    this.name = name;
    this.help = help;
    this._buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels = {}, value: number): void {
    const key = labelsKey(labels);
    if (!this._data.has(key)) {
      this._data.set(key, {
        buckets: new Array<number>(this._buckets.length).fill(0),
        sum: 0,
        count: 0,
      });
      this._labelMap.set(key, labels);
    }
    const d = this._data.get(key)!;
    for (let i = 0; i < this._buckets.length; i++) {
      if (value <= this._buckets[i]!) d.buckets[i]!++;
    }
    d.sum += value;
    d.count++;
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [key, d] of this._data) {
      const labels = this._labelMap.get(key) ?? {};
      const baseLabelStr = serialiseLabels(labels);
      // Buckets
      let cumulative = 0;
      for (let i = 0; i < this._buckets.length; i++) {
        cumulative += d.buckets[i]!;
        const leLabels = { ...labels, le: String(this._buckets[i]) };
        lines.push(`${this.name}_bucket${serialiseLabels(leLabels)} ${cumulative}`);
      }
      // +Inf bucket
      const infLabels = { ...labels, le: "+Inf" };
      lines.push(`${this.name}_bucket${serialiseLabels(infLabels)} ${d.count}`);
      lines.push(`${this.name}_sum${baseLabelStr} ${d.sum}`);
      lines.push(`${this.name}_count${baseLabelStr} ${d.count}`);
    }
    return lines.join("\n");
  }
}

/* ── Registry ────────────────────────────────────────────────────────────── */

class Registry {
  private readonly _metrics: Array<Counter | Gauge | Histogram> = [];

  register<T extends Counter | Gauge | Histogram>(metric: T): T {
    this._metrics.push(metric);
    return metric;
  }

  render(): string {
    return this._metrics.map((m) => m.render()).join("\n\n") + "\n";
  }
}

/* ── Singleton registry ──────────────────────────────────────────────────── */

export const registry = new Registry();

/* ── Metric declarations (spec §4.2) ─────────────────────────────────────── */

// ── HTTP
export const httpRequestsTotal = registry.register(
  new Counter("http_requests_total", "Total HTTP requests by method, route, and status")
);
export const httpRequestDurationSeconds = registry.register(
  new Histogram("http_request_duration_seconds", "HTTP request duration in seconds",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10])
);

// ── Visual identify
export const visualIdentifyRequestsTotal = registry.register(
  new Counter("visual_identify_requests_total", "Total visual identify requests by outcome")
);
export const visualIdentifyCacheHitsTotal = registry.register(
  new Counter("visual_identify_cache_hits_total", "Visual identify result cache hits")
);
export const visualIdentifyCacheMissesTotal = registry.register(
  new Counter("visual_identify_cache_misses_total", "Visual identify result cache misses")
);
export const visualIdentifyUpstreamErrorsTotal = registry.register(
  new Counter("visual_identify_upstream_errors_total", "Granite Vision upstream errors by code")
);

// ── Identify
export const identifyRequestsTotal = registry.register(
  new Counter("identify_requests_total", "Total identify requests by outcome")
);
export const identifyCacheHitsTotal = registry.register(
  new Counter("identify_cache_hits_total", "Identify result cache hits")
);
export const identifyCacheMissesTotal = registry.register(
  new Counter("identify_cache_misses_total", "Identify result cache misses")
);
export const identifyUpstreamErrorsTotal = registry.register(
  new Counter("identify_upstream_errors_total", "ACRCloud upstream errors by code")
);
export const identifyInFlight = registry.register(
  new Gauge("identify_in_flight", "Current in-flight ACRCloud calls")
);
export const identifyQueueDepth = registry.register(
  new Gauge("identify_queue_depth", "Current semaphore queue depth for ACRCloud calls")
);
export const identifyCircuitBreakerOpen = registry.register(
  new Gauge("identify_circuit_breaker_open", "1 when ACRCloud circuit breaker is open, 0 otherwise")
);

// ── Publish
export const publishJobsTotal = registry.register(
  new Counter("publish_jobs_total", "Total publish jobs by outcome")
);
export const publishBytesRelayedTotal = registry.register(
  new Counter("publish_bytes_relayed_total", "Total video bytes relayed to TikTok")
);
export const publishInFlight = registry.register(
  new Gauge("publish_in_flight", "Currently in-flight publish jobs")
);

// ── OAuth
export const oauthFlowsTotal = registry.register(
  new Counter("oauth_flows_total", "OAuth flow completions by provider and outcome")
);

// ── Rate limiting
export const rateLimitRejectionsTotal = registry.register(
  new Counter("rate_limit_rejections_total", "Rate limit rejections by bucket")
);

// ── Upstream errors (generic)
export const upstreamErrorsTotal = registry.register(
  new Counter("upstream_errors_total", "Upstream service errors by provider and type")
);

// ── Cleanup
export const cleanupRowsDeletedTotal = registry.register(
  new Counter("cleanup_rows_deleted_total", "Rows deleted by cleanup sweep by table")
);
