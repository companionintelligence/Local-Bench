// Uses Node's built-in `node:sqlite` module (DatabaseSync) instead of the
// native better-sqlite3 addon. better-sqlite3 ships a legacy Node
// C++/NAN-based addon that Deno's N-API compat layer cannot load, so it is
// permanently unsupported under Deno. node:sqlite is API-compatible enough
// (prepare/run/all/get/exec) and works both under Deno (built in, no flag
// required as of Deno 2.9) and under Node >=22.5 (stable without a flag as
// of Node 24). It does not provide better-sqlite3's `db.transaction()`
// helper, so the one use of that below is reimplemented manually with
// BEGIN/COMMIT/ROLLBACK.
import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';
import { SystemSpecs } from './systemSpecs';

export type BenchmarkTransport = 'ollama' | 'openai';
export type BenchmarkPath = 'direct' | 'pool';

export interface BenchmarkResult {
  id?: number;
  model: string;
  tokensPerSecond: number;
  totalTokens: number;
  durationSeconds: number;
  timestamp: string;
  success: boolean;
  error?: string;
  systemSpecsId?: number;
  // Hub-pool / transport metadata. All optional so rows written before these
  // columns existed still type-check; the reader returns null for absent ones.
  /** Which wire protocol was used. */
  transport?: BenchmarkTransport | null;
  /** 'pool' when the target was a CI-Hub pool proxy (URL or X-Hub-Pool-Served-By). */
  path?: BenchmarkPath | null;
  /** The base URL that was hit. */
  targetUrl?: string | null;
  /** X-Hub-Pool-Served-By */
  servedBy?: string | null;
  /** X-Hub-Pool-Backend */
  backend?: string | null;
  /** X-Hub-Pool-Request-Id */
  requestId?: string | null;
  /** Wall ms from request start to first content chunk (streaming only). */
  ttftMs?: number | null;
  /** prompt_eval_count / usage.prompt_tokens */
  promptTokens?: number | null;
  /** load_duration / 1e6 (ollama only) */
  loadMs?: number | null;
  /** prompt_eval_duration / 1e6 (ollama only) */
  promptEvalMs?: number | null;
  /** eval_duration / 1e6 (ollama only) */
  evalMs?: number | null;
  /** Engine decode speed, distinct from the wall-clock tokensPerSecond. */
  decodeTokensPerSecond?: number | null;
  /** How many requests ran at once in the batch this row belongs to (1 for a single run). */
  concurrency?: number | null;
  /** Shared by all rows of one concurrent batch. */
  batchId?: string | null;
}

/** Aggregate over one concurrent batch, as computed by src/benchmark.ts. */
export interface BenchmarkAggregate {
  batchId: string;
  model: string;
  concurrency: number;
  wallSeconds: number;
  /** sum(totalTokens) / wallSeconds */
  aggregateTokensPerSecond: number;
  medianTtftMs?: number;
  medianDecodeTokensPerSecond?: number;
  servedByCounts: Record<string, number>;
  backendCounts: Record<string, number>;
  successes: number;
  failures: number;
}

/** A benchmark_aggregates row as read back from the database. */
export interface BenchmarkAggregateRecord extends BenchmarkAggregate {
  id: number;
  medianTtftMs: number | undefined;
  medianDecodeTokensPerSecond: number | undefined;
  timestamp: string;
  systemSpecsId?: number;
}

export interface SystemSpecsRecord extends SystemSpecs {
  id?: number;
  timestamp: string;
}

const DB_PATH = path.join(__dirname, '..', 'benchmark_data.db');

let db: DatabaseSync | null = null;

/**
 * Columns added to benchmark_results after the original schema shipped.
 * Every entry is nullable so a pre-change database migrates in place with a
 * plain ADD COLUMN; `ensureColumns` skips the ones already present.
 */
const BENCHMARK_RESULT_COLUMNS: ReadonlyArray<[column: string, type: string]> = [
  ['transport', 'TEXT'],
  ['path', 'TEXT'],
  ['target_url', 'TEXT'],
  ['served_by', 'TEXT'],
  ['backend', 'TEXT'],
  ['request_id', 'TEXT'],
  ['ttft_ms', 'REAL'],
  ['prompt_tokens', 'INTEGER'],
  ['load_ms', 'REAL'],
  ['prompt_eval_ms', 'REAL'],
  ['eval_ms', 'REAL'],
  ['decode_tokens_per_second', 'REAL'],
  ['concurrency', 'INTEGER'],
  ['batch_id', 'TEXT']
];

/**
 * Add any of `columns` that `table` does not already have. SQLite has no
 * ADD COLUMN IF NOT EXISTS, so check PRAGMA table_info first. Safe to run on
 * every open.
 */
function ensureColumns(
  database: DatabaseSync,
  table: string,
  columns: ReadonlyArray<[column: string, type: string]>
): void {
  const existing = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
  );
  for (const [column, type] of columns) {
    if (!existing.has(column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

/**
 * Initialize the SQLite database and create tables if they don't exist
 */
export function initDatabase(): DatabaseSync {
  if (db) {
    return db;
  }

  db = new DatabaseSync(DB_PATH);

  // Create system_specs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT NOT NULL,
      cpu_model TEXT NOT NULL,
      cpu_cores INTEGER NOT NULL,
      cpu_threads INTEGER NOT NULL,
      total_memory_gb REAL NOT NULL,
      os_type TEXT NOT NULL,
      os_version TEXT NOT NULL,
      motherboard TEXT,
      gpus TEXT NOT NULL,
      strix_halo TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  // Create benchmark_results table. The original column set is kept here so
  // a brand-new database and a migrated one end up with the same shape; the
  // pool/transport columns are added by ensureColumns below in both cases.
  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      tokens_per_second REAL NOT NULL,
      total_tokens INTEGER NOT NULL,
      duration_seconds REAL NOT NULL,
      timestamp TEXT NOT NULL,
      success INTEGER NOT NULL,
      error TEXT,
      system_specs_id INTEGER,
      FOREIGN KEY (system_specs_id) REFERENCES system_specs(id)
    )
  `);

  ensureColumns(db, 'benchmark_results', BENCHMARK_RESULT_COLUMNS);

  // One row per concurrent batch, summarising the concurrency rows in
  // benchmark_results that share its batch_id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_aggregates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL,
      concurrency INTEGER NOT NULL,
      wall_seconds REAL NOT NULL,
      aggregate_tokens_per_second REAL NOT NULL,
      median_ttft_ms REAL,
      median_decode_tokens_per_second REAL,
      served_by_counts TEXT NOT NULL,
      backend_counts TEXT NOT NULL,
      successes INTEGER NOT NULL,
      failures INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      system_specs_id INTEGER,
      FOREIGN KEY (system_specs_id) REFERENCES system_specs(id)
    )
  `);

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_benchmark_timestamp
    ON benchmark_results(timestamp);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_benchmark_model
    ON benchmark_results(model);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_benchmark_batch_id
    ON benchmark_results(batch_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_system_specs_timestamp
    ON system_specs(timestamp);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_benchmark_aggregates_timestamp
    ON benchmark_aggregates(timestamp);
  `);

  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get the database instance
 */
export function getDatabase(): DatabaseSync {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Save system specs to database
 */
export function saveSystemSpecs(specs: SystemSpecs): number {
  const database = getDatabase();

  const stmt = database.prepare(`
    INSERT INTO system_specs (
      server_name, cpu_model, cpu_cores, cpu_threads,
      total_memory_gb, os_type, os_version, motherboard,
      gpus, strix_halo, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    specs.serverName,
    specs.cpuModel,
    specs.cpuCores,
    specs.cpuThreads,
    specs.totalMemoryGB,
    specs.osType,
    specs.osVersion,
    specs.motherboard || null,
    JSON.stringify(specs.gpus),
    specs.strixHalo ? JSON.stringify(specs.strixHalo) : null,
    new Date().toISOString()
  );

  return result.lastInsertRowid as number;
}

/** Bind an optional string field: undefined/null → NULL. */
function optText(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value;
}

/** Bind an optional numeric field: undefined/null/NaN → NULL. */
function optNum(value: number | null | undefined): number | null {
  return value === undefined || value === null || Number.isNaN(value) ? null : value;
}

/**
 * Save benchmark results to database
 */
export function saveBenchmarkResults(results: BenchmarkResult[], systemSpecsId?: number): void {
  const database = getDatabase();

  const stmt = database.prepare(`
    INSERT INTO benchmark_results (
      model, tokens_per_second, total_tokens, duration_seconds,
      timestamp, success, error, system_specs_id,
      transport, path, target_url, served_by, backend, request_id,
      ttft_ms, prompt_tokens, load_ms, prompt_eval_ms, eval_ms,
      decode_tokens_per_second, concurrency, batch_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // node:sqlite has no built-in `database.transaction()` helper (unlike
  // better-sqlite3), so wrap the batch insert manually.
  database.exec('BEGIN');
  try {
    for (const result of results) {
      stmt.run(
        result.model,
        result.tokensPerSecond,
        result.totalTokens,
        result.durationSeconds,
        result.timestamp,
        result.success ? 1 : 0,
        result.error || null,
        systemSpecsId || null,
        optText(result.transport),
        optText(result.path),
        optText(result.targetUrl),
        optText(result.servedBy),
        optText(result.backend),
        optText(result.requestId),
        optNum(result.ttftMs),
        optNum(result.promptTokens),
        optNum(result.loadMs),
        optNum(result.promptEvalMs),
        optNum(result.evalMs),
        optNum(result.decodeTokensPerSecond),
        optNum(result.concurrency),
        optText(result.batchId)
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The benchmark_results column list every reader selects, aliased to the
 * BenchmarkResult field names. `prefix` is the table alias in a join.
 */
function benchmarkResultColumns(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return `
      ${p}id, ${p}model, ${p}tokens_per_second as tokensPerSecond,
      ${p}total_tokens as totalTokens, ${p}duration_seconds as durationSeconds,
      ${p}timestamp, ${p}success, ${p}error, ${p}system_specs_id as systemSpecsId,
      ${p}transport, ${p}path, ${p}target_url as targetUrl, ${p}served_by as servedBy,
      ${p}backend, ${p}request_id as requestId, ${p}ttft_ms as ttftMs,
      ${p}prompt_tokens as promptTokens, ${p}load_ms as loadMs,
      ${p}prompt_eval_ms as promptEvalMs, ${p}eval_ms as evalMs,
      ${p}decode_tokens_per_second as decodeTokensPerSecond,
      ${p}concurrency, ${p}batch_id as batchId`;
}

/**
 * Get all benchmark results
 */
export function getAllBenchmarkResults(): BenchmarkResult[] {
  const database = getDatabase();

  const stmt = database.prepare(`
    SELECT ${benchmarkResultColumns()}
    FROM benchmark_results
    ORDER BY timestamp DESC
  `);

  const rows = stmt.all() as any[];

  return rows.map(row => ({
    ...row,
    success: Boolean(row.success)
  }));
}

/**
 * Get benchmark results by model
 */
export function getBenchmarkResultsByModel(model: string): BenchmarkResult[] {
  const database = getDatabase();

  const stmt = database.prepare(`
    SELECT ${benchmarkResultColumns()}
    FROM benchmark_results
    WHERE model = ?
    ORDER BY timestamp DESC
  `);

  const rows = stmt.all(model) as any[];

  return rows.map(row => ({
    ...row,
    success: Boolean(row.success)
  }));
}

/**
 * Get latest system specs
 */
export function getLatestSystemSpecs(): SystemSpecsRecord | null {
  const database = getDatabase();

  const stmt = database.prepare(`
    SELECT
      id, server_name as serverName, cpu_model as cpuModel,
      cpu_cores as cpuCores, cpu_threads as cpuThreads,
      total_memory_gb as totalMemoryGB, os_type as osType,
      os_version as osVersion, motherboard, gpus, strix_halo as strixHalo, timestamp
    FROM system_specs
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get() as any;

  if (!row) {
    return null;
  }

  return {
    ...row,
    gpus: safeJsonParse(row.gpus, []),
    strixHalo: row.strixHalo ? safeJsonParse(row.strixHalo, undefined) : undefined
  };
}

/**
 * Get all system specs records
 */
export function getAllSystemSpecs(): SystemSpecsRecord[] {
  const database = getDatabase();

  const stmt = database.prepare(`
    SELECT
      id, server_name as serverName, cpu_model as cpuModel,
      cpu_cores as cpuCores, cpu_threads as cpuThreads,
      total_memory_gb as totalMemoryGB, os_type as osType,
      os_version as osVersion, motherboard, gpus, strix_halo as strixHalo, timestamp
    FROM system_specs
    ORDER BY timestamp DESC
  `);

  const rows = stmt.all() as any[];

  return rows.map(row => ({
    ...row,
    gpus: safeJsonParse(row.gpus, []),
    strixHalo: row.strixHalo ? safeJsonParse(row.strixHalo, undefined) : undefined
  }));
}

/**
 * Get benchmark results with system specs
 */
export function getBenchmarkResultsWithSpecs(limit?: number): Array<BenchmarkResult & { systemSpecs?: SystemSpecsRecord }> {
  const database = getDatabase();

  const query = `
    SELECT ${benchmarkResultColumns('br')},
      ss.server_name as serverName, ss.cpu_model as cpuModel,
      ss.cpu_cores as cpuCores, ss.cpu_threads as cpuThreads,
      ss.total_memory_gb as totalMemoryGB, ss.os_type as osType,
      ss.os_version as osVersion, ss.motherboard, ss.gpus, ss.strix_halo as strixHalo
    FROM benchmark_results br
    LEFT JOIN system_specs ss ON br.system_specs_id = ss.id
    ORDER BY br.timestamp DESC
  `;

  const stmt = limit && limit > 0
    ? database.prepare(query + ' LIMIT ?')
    : database.prepare(query);

  const rows = limit && limit > 0
    ? stmt.all(limit) as any[]
    : stmt.all() as any[];

  return mapResultsWithSpecs(rows);
}

function mapResultsWithSpecs(rows: any[]): Array<BenchmarkResult & { systemSpecs?: SystemSpecsRecord }> {
  return rows.map(row => {
    const result: BenchmarkResult & { systemSpecs?: SystemSpecsRecord } = {
      id: row.id,
      model: row.model,
      tokensPerSecond: row.tokensPerSecond,
      totalTokens: row.totalTokens,
      durationSeconds: row.durationSeconds,
      timestamp: row.timestamp,
      success: Boolean(row.success),
      error: row.error,
      systemSpecsId: row.systemSpecsId,
      transport: row.transport,
      path: row.path,
      targetUrl: row.targetUrl,
      servedBy: row.servedBy,
      backend: row.backend,
      requestId: row.requestId,
      ttftMs: row.ttftMs,
      promptTokens: row.promptTokens,
      loadMs: row.loadMs,
      promptEvalMs: row.promptEvalMs,
      evalMs: row.evalMs,
      decodeTokensPerSecond: row.decodeTokensPerSecond,
      concurrency: row.concurrency,
      batchId: row.batchId
    };

    if (row.serverName) {
      result.systemSpecs = {
        id: row.systemSpecsId,
        serverName: row.serverName,
        cpuModel: row.cpuModel,
        cpuCores: row.cpuCores,
        cpuThreads: row.cpuThreads,
        totalMemoryGB: row.totalMemoryGB,
        osType: row.osType,
        osVersion: row.osVersion,
        motherboard: row.motherboard,
        gpus: safeJsonParse(row.gpus, []),
        strixHalo: row.strixHalo ? safeJsonParse(row.strixHalo, undefined) : undefined,
        timestamp: row.timestamp
      };
    }

    return result;
  });
}

/**
 * Save one batch aggregate. batch_id is UNIQUE, so re-saving the same batch
 * replaces the earlier row (the batch was re-aggregated) rather than failing.
 * Returns the row id.
 */
export function saveBenchmarkAggregate(aggregate: BenchmarkAggregate, systemSpecsId?: number): number {
  const database = getDatabase();

  const stmt = database.prepare(`
    INSERT INTO benchmark_aggregates (
      batch_id, model, concurrency, wall_seconds, aggregate_tokens_per_second,
      median_ttft_ms, median_decode_tokens_per_second,
      served_by_counts, backend_counts, successes, failures,
      timestamp, system_specs_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id) DO UPDATE SET
      model = excluded.model,
      concurrency = excluded.concurrency,
      wall_seconds = excluded.wall_seconds,
      aggregate_tokens_per_second = excluded.aggregate_tokens_per_second,
      median_ttft_ms = excluded.median_ttft_ms,
      median_decode_tokens_per_second = excluded.median_decode_tokens_per_second,
      served_by_counts = excluded.served_by_counts,
      backend_counts = excluded.backend_counts,
      successes = excluded.successes,
      failures = excluded.failures,
      timestamp = excluded.timestamp,
      system_specs_id = excluded.system_specs_id
  `);

  stmt.run(
    aggregate.batchId,
    aggregate.model,
    aggregate.concurrency,
    aggregate.wallSeconds,
    aggregate.aggregateTokensPerSecond,
    optNum(aggregate.medianTtftMs),
    optNum(aggregate.medianDecodeTokensPerSecond),
    JSON.stringify(aggregate.servedByCounts ?? {}),
    JSON.stringify(aggregate.backendCounts ?? {}),
    aggregate.successes,
    aggregate.failures,
    new Date().toISOString(),
    systemSpecsId || null
  );

  // lastInsertRowid is not updated by the DO UPDATE branch, so look the row up.
  const row = database
    .prepare('SELECT id FROM benchmark_aggregates WHERE batch_id = ?')
    .get(aggregate.batchId) as { id: number };
  return row.id;
}

/**
 * Most recent batch aggregates, newest first.
 */
export function getRecentAggregates(limit?: number): BenchmarkAggregateRecord[] {
  const database = getDatabase();

  const query = `
    SELECT
      id, batch_id as batchId, model, concurrency, wall_seconds as wallSeconds,
      aggregate_tokens_per_second as aggregateTokensPerSecond,
      median_ttft_ms as medianTtftMs,
      median_decode_tokens_per_second as medianDecodeTokensPerSecond,
      served_by_counts as servedByCounts, backend_counts as backendCounts,
      successes, failures, timestamp, system_specs_id as systemSpecsId
    FROM benchmark_aggregates
    ORDER BY timestamp DESC, id DESC
  `;

  const rows = limit && limit > 0
    ? database.prepare(query + ' LIMIT ?').all(limit) as any[]
    : database.prepare(query).all() as any[];

  return rows.map(row => ({
    id: row.id,
    batchId: row.batchId,
    model: row.model,
    concurrency: row.concurrency,
    wallSeconds: row.wallSeconds,
    aggregateTokensPerSecond: row.aggregateTokensPerSecond,
    medianTtftMs: row.medianTtftMs ?? undefined,
    medianDecodeTokensPerSecond: row.medianDecodeTokensPerSecond ?? undefined,
    servedByCounts: safeJsonParse<Record<string, number>>(row.servedByCounts, {}),
    backendCounts: safeJsonParse<Record<string, number>>(row.backendCounts, {}),
    successes: row.successes,
    failures: row.failures,
    timestamp: row.timestamp,
    systemSpecsId: row.systemSpecsId ?? undefined
  }));
}

/**
 * Safely parse JSON with fallback
 */
function safeJsonParse<T>(jsonString: string, fallback: T): T {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Error parsing JSON:', error);
    return fallback;
  }
}
