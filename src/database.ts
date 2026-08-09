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
}

export interface SystemSpecsRecord extends SystemSpecs {
  id?: number;
  timestamp: string;
}

const DB_PATH = path.join(__dirname, '..', 'benchmark_data.db');

let db: DatabaseSync | null = null;

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

  // Create benchmark_results table
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
    CREATE INDEX IF NOT EXISTS idx_system_specs_timestamp 
    ON system_specs(timestamp);
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

/**
 * Save benchmark results to database
 */
export function saveBenchmarkResults(results: BenchmarkResult[], systemSpecsId?: number): void {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    INSERT INTO benchmark_results (
      model, tokens_per_second, total_tokens, duration_seconds,
      timestamp, success, error, system_specs_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        systemSpecsId || null
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Get all benchmark results
 */
export function getAllBenchmarkResults(): BenchmarkResult[] {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT 
      id, model, tokens_per_second as tokensPerSecond, 
      total_tokens as totalTokens, duration_seconds as durationSeconds,
      timestamp, success, error, system_specs_id as systemSpecsId
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
    SELECT 
      id, model, tokens_per_second as tokensPerSecond, 
      total_tokens as totalTokens, duration_seconds as durationSeconds,
      timestamp, success, error, system_specs_id as systemSpecsId
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
    SELECT 
      br.id, br.model, br.tokens_per_second as tokensPerSecond,
      br.total_tokens as totalTokens, br.duration_seconds as durationSeconds,
      br.timestamp, br.success, br.error, br.system_specs_id as systemSpecsId,
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
      systemSpecsId: row.systemSpecsId
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
