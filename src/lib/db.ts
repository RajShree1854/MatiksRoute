import Database from 'better-sqlite3';
import path from 'path';
import { ImageAction, ProviderName, ComplexityTier, RequestLog, QuotaStatus } from '@/providers/types';

declare global {
  // eslint-disable-next-line no-var
  var __db: Database.Database | undefined;
}

function openDatabase(): Database.Database {
  const dbPath = path.join(process.cwd(), 'matiksroute.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp           TEXT    NOT NULL,
      complexity_tier     TEXT    NOT NULL,
      smart_route_target  TEXT    NOT NULL,
      provider_attempted  TEXT    NOT NULL,
      provider_succeeded  TEXT,
      fallback_triggered  INTEGER NOT NULL DEFAULT 0,
      mid_stream_failover INTEGER NOT NULL DEFAULT 0,
      had_images          INTEGER NOT NULL DEFAULT 0,
      image_action        TEXT    NOT NULL DEFAULT 'none',
      original_tokens     INTEGER NOT NULL DEFAULT 0,
      compressed_tokens   INTEGER NOT NULL DEFAULT 0,
      tokens_saved_pct    REAL    NOT NULL DEFAULT 0,
      latency_ms          INTEGER NOT NULL DEFAULT 0,
      error_reason        TEXT
    );

    CREATE TABLE IF NOT EXISTS quota_snapshots (
      provider            TEXT    PRIMARY KEY,
      tokens_used_minute  INTEGER NOT NULL DEFAULT 0,
      cooldown_until      INTEGER,
      total_requests      INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

function getDb(): Database.Database {
  if (!global.__db) global.__db = openDatabase();
  return global.__db;
}

export function insertRequestLog(log: Omit<RequestLog, 'id'>): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO request_logs (
      timestamp, complexity_tier, smart_route_target, provider_attempted,
      provider_succeeded, fallback_triggered, mid_stream_failover,
      had_images, image_action, original_tokens, compressed_tokens,
      tokens_saved_pct, latency_ms, error_reason
    ) VALUES (
      @timestamp, @complexityTier, @smartRouteTarget, @providerAttempted,
      @providerSucceeded, @fallbackTriggered, @midStreamFailover,
      @hadImages, @imageAction, @originalTokens, @compressedTokens,
      @tokensSavedPct, @latencyMs, @errorReason
    )
  `);

  stmt.run({
    timestamp: log.timestamp,
    complexityTier: log.complexityTier,
    smartRouteTarget: log.smartRouteTarget,
    providerAttempted: log.providerAttempted,
    providerSucceeded: log.providerSucceeded ?? null,
    fallbackTriggered: log.fallbackTriggered ? 1 : 0,
    midStreamFailover: log.midStreamFailover ? 1 : 0,
    hadImages: log.hadImages ? 1 : 0,
    imageAction: log.imageAction,
    originalTokens: log.originalTokens,
    compressedTokens: log.compressedTokens,
    tokensSavedPct: log.tokensSavedPct,
    latencyMs: log.latencyMs,
    errorReason: log.errorReason ?? null,
  });
}

export function getRecentLogs(limit = 50): Partial<RequestLog>[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        id, timestamp,
        complexity_tier AS complexityTier,
        smart_route_target AS smartRouteTarget,
        provider_attempted AS providerAttempted,
        provider_succeeded AS providerSucceeded,
        fallback_triggered AS fallbackTriggered,
        mid_stream_failover AS midStreamFailover,
        had_images AS hadImages,
        image_action AS imageAction,
        original_tokens AS originalTokens,
        compressed_tokens AS compressedTokens,
        tokens_saved_pct AS tokensSavedPct,
        latency_ms AS latencyMs,
        error_reason AS errorReason
       FROM request_logs
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    // Always-present fields
    const entry: Record<string, unknown> = {
      id: r.id,
      timestamp: r.timestamp,
      complexityTier: r.complexityTier,
      smartRouteTarget: r.smartRouteTarget,
      providerAttempted: r.providerAttempted,
      providerSucceeded: r.providerSucceeded,
      fallbackTriggered: Boolean(r.fallbackTriggered),
      latencyMs: r.latencyMs,
      originalTokens: r.originalTokens,
      compressedTokens: r.compressedTokens,
    };

    // Only include tokensSavedPct when meaningful
    const pct = r.tokensSavedPct as number;
    if (pct !== 0) entry.tokensSavedPct = Math.round(pct * 100) / 100;

    // Only include when true / non-default
    if (r.midStreamFailover) entry.midStreamFailover = true;
    if (r.hadImages) {
      entry.hadImages = true;
      entry.imageAction = r.imageAction;
    }

    // Only include errorReason when there was actually an error
    if (r.errorReason) entry.errorReason = r.errorReason;

    return entry;
  });
}

export function upsertQuotaSnapshot(snapshot: QuotaStatus): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO quota_snapshots (provider, tokens_used_minute, cooldown_until, total_requests)
    VALUES (@provider, @tokensUsedThisMinute, @cooldownUntil, @totalRequests)
    ON CONFLICT(provider) DO UPDATE SET
      tokens_used_minute = excluded.tokens_used_minute,
      cooldown_until     = excluded.cooldown_until,
      total_requests     = excluded.total_requests
  `).run({
    provider: snapshot.provider,
    tokensUsedThisMinute: snapshot.tokensUsedThisMinute,
    cooldownUntil: snapshot.cooldownUntil,
    totalRequests: snapshot.totalRequests,
  });
}
