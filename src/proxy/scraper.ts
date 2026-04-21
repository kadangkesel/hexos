import { batchAddProxies } from "./pool.ts";
import { log } from "../utils/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxySource {
  id: string;
  name: string;
  type: "http" | "socks4" | "socks5";
  url: string;
}

export interface ScrapedProxy {
  url: string;
  type: string;
  source: string;
  alive: boolean;
  pingMs: number | null;
  testedAt: number;
}

export interface ScrapeJob {
  id: string;
  status: "idle" | "fetching" | "testing" | "done" | "error";
  sources: string[];
  totalFetched: number;
  totalTesting: number;
  totalTested: number;
  totalAlive: number;
  totalDead: number;
  results: ScrapedProxy[];
  startedAt: number | null;
  error?: string;
  concurrency: number;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const SOURCES: ProxySource[] = [
  { id: "speedx-socks5", name: "TheSpeedX SOCKS5", type: "socks5", url: "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt" },
  { id: "speedx-socks4", name: "TheSpeedX SOCKS4", type: "socks4", url: "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt" },
  { id: "speedx-http", name: "TheSpeedX HTTP", type: "http", url: "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt" },
  { id: "clarketm-http", name: "clarketm HTTP", type: "http", url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt" },
  { id: "monosans-http", name: "monosans HTTP", type: "http", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt" },
  { id: "monosans-socks5", name: "monosans SOCKS5", type: "socks5", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt" },
  { id: "hookzof-socks5", name: "hookzof SOCKS5", type: "socks5", url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt" },
];

const HEALTH_CHECK_URL = "http://httpbin.org/ip";
const TEST_TIMEOUT = 8_000;
const HOST_PORT_RE = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;

// ---------------------------------------------------------------------------
// Module-level job state
// ---------------------------------------------------------------------------

let cancelled = false;

let currentJob: ScrapeJob = {
  id: "",
  status: "idle",
  sources: [],
  totalFetched: 0,
  totalTesting: 0,
  totalTested: 0,
  totalAlive: 0,
  totalDead: 0,
  results: [],
  startedAt: null,
  concurrency: 50,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get list of available proxy sources. */
export function getSources(): ProxySource[] {
  return [...SOURCES];
}

/** Get current scrape job status. */
export function getScrapeStatus(): ScrapeJob {
  return { ...currentJob, results: [...currentJob.results] };
}

/**
 * Start a scrape job (non-blocking, runs in background).
 * @param sourceIds Which sources to scrape. Empty or undefined = all.
 * @param concurrency How many proxies to test in parallel (default 50).
 */
export async function startScrape(sourceIds?: string[], concurrency?: number): Promise<void> {
  if (currentJob.status === "fetching" || currentJob.status === "testing") {
    throw new Error("A scrape job is already running. Wait for it to finish or check status.");
  }

  const selectedSources = sourceIds && sourceIds.length > 0
    ? SOURCES.filter((s) => sourceIds.includes(s.id))
    : [...SOURCES];

  if (selectedSources.length === 0) {
    throw new Error("No valid source IDs provided.");
  }

  const jobConcurrency = concurrency ?? 50;

  // Reset cancel flag and job state
  cancelled = false;
  currentJob = {
    id: crypto.randomUUID(),
    status: "fetching",
    sources: selectedSources.map((s) => s.id),
    totalFetched: 0,
    totalTesting: 0,
    totalTested: 0,
    totalAlive: 0,
    totalDead: 0,
    results: [],
    startedAt: Date.now(),
    concurrency: jobConcurrency,
  };

  log.info(`Scrape job ${currentJob.id.slice(0, 8)} started — ${selectedSources.length} source(s), concurrency ${jobConcurrency}`);

  // Run in background (non-blocking)
  runScrapeJob(selectedSources, jobConcurrency).catch((err) => {
    currentJob.status = "error";
    currentJob.error = String(err);
    log.error(`Scrape job failed: ${err}`);
  });
}

/**
 * Cancel the current scrape job.
 */
export function cancelScrape(): void {
  if (currentJob.status === "fetching" || currentJob.status === "testing") {
    cancelled = true;
    currentJob.status = "done";
    currentJob.error = "Cancelled by user";
    log.warn("Scrape job cancelled by user");
  }
}

/**
 * Integrate alive results into the proxy pool.
 * @param proxyUrls Optional list of specific proxy URLs to integrate. If empty, integrates all alive results.
 * @returns Count of proxies added and duplicates skipped.
 */
export async function integrateResults(proxyUrls?: string[]): Promise<{ added: number; duplicates: number }> {
  const alive = currentJob.results.filter((p) => p.alive);

  if (alive.length === 0) {
    log.warn("No alive proxies to integrate.");
    return { added: 0, duplicates: 0 };
  }

  let toIntegrate: ScrapedProxy[];
  if (proxyUrls && proxyUrls.length > 0) {
    const urlSet = new Set(proxyUrls);
    toIntegrate = alive.filter((p) => urlSet.has(p.url));
  } else {
    toIntegrate = alive;
  }

  if (toIntegrate.length === 0) {
    log.warn("No matching alive proxies found for integration.");
    return { added: 0, duplicates: 0 };
  }

  const text = toIntegrate.map((p) => p.url).join("\n");
  const result = await batchAddProxies(text);

  log.ok(`Integrated ${result.added} proxies into pool (${result.duplicates} duplicates skipped)`);
  return { added: result.added, duplicates: result.duplicates };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Fetch proxy lists from all selected sources, deduplicate, test, and store results.
 */
async function runScrapeJob(sources: ProxySource[], concurrency: number): Promise<void> {
  // Phase 1: Fetch all sources
  const rawProxies: { url: string; type: string; source: string }[] = [];

  for (const source of sources) {
    try {
      log.info(`Fetching ${source.name} (${source.url})`);
      const res = await fetch(source.url, {
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        log.warn(`Failed to fetch ${source.name}: HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();
      const lines = text.split(/\r?\n/);
      let count = 0;

      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;

        // Extract host:port — some lists may have extra columns
        const hostPort = line.split(/\s+/)[0];
        if (!HOST_PORT_RE.test(hostPort)) continue;

        rawProxies.push({
          url: `${source.type}://${hostPort}`,
          type: source.type,
          source: source.id,
        });
        count++;
      }

      log.ok(`${source.name}: ${count} proxies fetched`);
    } catch (err) {
      log.warn(`Error fetching ${source.name}: ${err}`);
    }
  }

  currentJob.totalFetched = rawProxies.length;
  log.info(`Total fetched: ${rawProxies.length} proxies (before dedup)`);

  // Phase 2: Deduplicate by URL
  const seen = new Set<string>();
  const unique: typeof rawProxies = [];
  for (const proxy of rawProxies) {
    if (!seen.has(proxy.url)) {
      seen.add(proxy.url);
      unique.push(proxy);
    }
  }

  log.info(`After dedup: ${unique.length} unique proxies (removed ${rawProxies.length - unique.length} duplicates)`);

  // Phase 3: Test in parallel batches
  currentJob.status = "testing";
  currentJob.totalTesting = unique.length;

  for (let i = 0; i < unique.length; i += concurrency) {
    if (cancelled) break;
    const batch = unique.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((p) => testProxy(p.url, p.type, p.source)));

    for (const result of batchResults) {
      if (result.alive) {
        currentJob.totalAlive++;
        currentJob.results.push(result);
      } else {
        currentJob.totalDead++;
      }
    }

    currentJob.totalTested += batch.length;

    const pct = Math.round((currentJob.totalTested / unique.length) * 100);
    log.info(
      `Testing progress: ${currentJob.totalTested}/${unique.length} (${pct}%) — ` +
      `${currentJob.totalAlive} alive, ${currentJob.totalDead} dead`
    );
  }

  // Done
  currentJob.status = "done";
  log.ok(
    `Scrape job complete: ${currentJob.totalAlive} alive out of ${currentJob.totalTested} tested ` +
    `(${currentJob.totalDead} dead)`
  );
}

/**
 * Test a single proxy by making a request through it.
 */
async function testProxy(proxyUrl: string, type: string, source: string): Promise<ScrapedProxy> {
  const start = performance.now();
  let alive = false;
  let pingMs: number | null = null;

  try {
    const res = await fetch(HEALTH_CHECK_URL, {
      proxy: proxyUrl,
      signal: AbortSignal.timeout(TEST_TIMEOUT),
    } as any);

    if (res.ok) {
      pingMs = Math.round(performance.now() - start);
      alive = true;
    }
  } catch {
    // Connection failed or timed out
  }

  return {
    url: proxyUrl,
    type,
    source,
    alive,
    pingMs,
    testedAt: Date.now(),
  };
}
