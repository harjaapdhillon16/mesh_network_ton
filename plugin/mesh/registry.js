import { Pool } from 'pg';

const BASE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS peers (
    address TEXT PRIMARY KEY,
    skills JSONB,
    min_fee NUMERIC,
    response_time TEXT,
    reputation INTEGER,
    stake NUMERIC,
    stake_age_seconds BIGINT,
    reply_chat TEXT,
    last_seen BIGINT,
    created_at BIGINT,
    updated_at BIGINT
  );`,
  `CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    from_address TEXT,
    skill TEXT,
    payload JSONB,
    budget NUMERIC,
    deadline BIGINT,
    min_reputation INTEGER,
    status TEXT,
    created_at BIGINT,
    accepted_offer_id TEXT,
    selected_executor TEXT,
    updated_at BIGINT
  );`,
  `CREATE TABLE IF NOT EXISTS deals (
    intent_id TEXT PRIMARY KEY,
    executor_address TEXT,
    fee NUMERIC,
    tx_hash TEXT,
    outcome TEXT,
    rating INTEGER,
    settled_at BIGINT,
    updated_at BIGINT
  );`,
  `CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    intent_id TEXT,
    from_address TEXT,
    fee NUMERIC,
    fee_raw TEXT,
    eta TEXT,
    reputation INTEGER,
    stake_age_seconds BIGINT,
    escrow_address TEXT,
    created_at BIGINT
  );`,
  `CREATE TABLE IF NOT EXISTS processed_messages (
    message_key TEXT PRIMARY KEY,
    message_type TEXT,
    source_chat_id TEXT,
    source_message_id TEXT,
    payload_hash TEXT,
    first_seen_at BIGINT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_intents_status_deadline ON intents(status, deadline);`,
  `CREATE INDEX IF NOT EXISTS idx_offers_intent_created ON offers(intent_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_deals_settled_at ON deals(settled_at DESC);`,
];

// SQLite-compatible fallback DDL (best-effort only when sdk.db exists and Postgres is not configured)
const SQLITE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS peers (
    address TEXT PRIMARY KEY,
    skills TEXT,
    min_fee REAL,
    response_time TEXT,
    reputation INTEGER,
    stake REAL,
    stake_age_seconds INTEGER,
    reply_chat TEXT,
    last_seen INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    from_address TEXT,
    skill TEXT,
    payload TEXT,
    budget REAL,
    deadline INTEGER,
    min_reputation INTEGER,
    status TEXT,
    created_at INTEGER,
    accepted_offer_id TEXT,
    selected_executor TEXT,
    updated_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS deals (
    intent_id TEXT PRIMARY KEY,
    executor_address TEXT,
    fee REAL,
    tx_hash TEXT,
    outcome TEXT,
    rating INTEGER,
    settled_at INTEGER,
    updated_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    intent_id TEXT,
    from_address TEXT,
    fee REAL,
    fee_raw TEXT,
    eta TEXT,
    reputation INTEGER,
    stake_age_seconds INTEGER,
    escrow_address TEXT,
    created_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS processed_messages (
    message_key TEXT PRIMARY KEY,
    message_type TEXT,
    source_chat_id TEXT,
    source_message_id TEXT,
    payload_hash TEXT,
    first_seen_at INTEGER
  );`,
];

function now() {
  return Math.floor(Date.now() / 1000);
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getRuntimeConfig(sdk) {
  return sdk?.__meshRuntimeConfig || {};
}

function resolveDbUrl(sdk) {
  const cfg = getRuntimeConfig(sdk);
  return cfg.databaseUrl || process.env.MESH_DATABASE_URL || process.env.DATABASE_URL || null;
}

function resolveSupabaseUrl(sdk) {
  const cfg = getRuntimeConfig(sdk);
  return cfg.supabaseUrl || process.env.MESH_SUPABASE_URL || process.env.SUPABASE_URL || null;
}

function resolveSupabaseServiceRoleKey(sdk) {
  const cfg = getRuntimeConfig(sdk);
  return cfg.supabaseServiceRoleKey || process.env.MESH_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

function resolvePgSsl(sdk) {
  const cfg = getRuntimeConfig(sdk);
  if (cfg.dbSsl === false) return false;
  return { rejectUnauthorized: false };
}

function hasSupabaseRestConfig(sdk) {
  return Boolean(resolveSupabaseUrl(sdk) && resolveSupabaseServiceRoleKey(sdk));
}

function getBackendMode(sdk) {
  if (hasSupabaseRestConfig(sdk)) return 'supabase-rest';
  if (getPgPool(sdk)) return 'postgres';
  return 'memory';
}

function ensureStore(sdk) {
  if (!sdk.__meshStore) {
    sdk.__meshStore = {
      peers: new Map(),
      intents: new Map(),
      offers: new Map(),
      deals: new Map(),
      processedMessages: new Set(),
    };
  }
  return sdk.__meshStore;
}

function getLogger(sdk) {
  return sdk?.logger || console;
}

function setRuntimeConfig(sdk, config) {
  if (config && typeof config === 'object') {
    sdk.__meshRuntimeConfig = { ...(sdk.__meshRuntimeConfig || {}), ...config };
  }
}

function getPgPool(sdk) {
  if (sdk.__meshPgPool === null) return null;
  if (sdk.__meshPgPool) return sdk.__meshPgPool;

  const databaseUrl = resolveDbUrl(sdk);
  if (!databaseUrl) {
    sdk.__meshPgPool = null;
    return null;
  }

  const cfg = getRuntimeConfig(sdk);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: toInt(cfg.dbPoolMax || process.env.MESH_DB_POOL_MAX, 10) || 10,
    ssl: resolvePgSsl(sdk),
  });
  pool.on('error', (err) => {
    getLogger(sdk).error?.('[MESH] Postgres pool error', err);
  });

  sdk.__meshPgPool = pool;
  return pool;
}

function buildSupabaseUrl(baseUrl, path, query = null) {
  const normalized = String(baseUrl).replace(/\/+$/, '');
  const url = new URL(`${normalized}/rest/v1/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function supabaseRequest(sdk, { method = 'GET', path, query, body, prefer, headers = {}, allow404 = false }) {
  const baseUrl = resolveSupabaseUrl(sdk);
  const apiKey = resolveSupabaseServiceRoleKey(sdk);
  if (!baseUrl || !apiKey) {
    throw new Error('Supabase REST not configured');
  }

  const requestHeaders = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    ...headers,
  };
  if (prefer) requestHeaders.Prefer = prefer;

  let payload;
  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(buildSupabaseUrl(baseUrl, path, query), {
    method,
    headers: requestHeaders,
    body: payload,
  });

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (!res.ok) {
    if (allow404 && res.status === 404) return { ok: false, status: 404, data: json };
    const msg = typeof json === 'object' && json
      ? (json.message || json.error || json.hint || JSON.stringify(json))
      : String(json || `HTTP ${res.status}`);
    const err = new Error(`Supabase REST ${method} ${path} failed: ${msg}`);
    err.status = res.status;
    err.response = json;
    throw err;
  }

  return { ok: true, status: res.status, data: json };
}

async function supabaseSelectOne(sdk, table, filters) {
  const query = { select: '*', limit: 1, ...filters };
  const { data } = await supabaseRequest(sdk, {
    method: 'GET',
    path: table,
    query,
    headers: { Accept: 'application/json' },
  });
  return Array.isArray(data) ? data[0] ?? null : null;
}

async function supabaseUpsertOne(sdk, table, row, onConflict) {
  const { data } = await supabaseRequest(sdk, {
    method: 'POST',
    path: table,
    query: onConflict ? { on_conflict: onConflict } : undefined,
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return Array.isArray(data) ? data[0] ?? null : null;
}

async function supabaseInsertIgnoreDuplicate(sdk, table, row) {
  const { data } = await supabaseRequest(sdk, {
    method: 'POST',
    path: table,
    body: row,
    prefer: 'resolution=ignore-duplicates,return=representation',
  });
  return Array.isArray(data) ? data : [];
}

function encodeEq(value) {
  return `eq.${String(value)}`;
}

function encodeLt(value) {
  return `lt.${String(value)}`;
}

async function queryPg(sdk, text, params = [], client = null) {
  const executor = client || getPgPool(sdk);
  if (!executor) throw new Error('Postgres not configured');
  return executor.query(text, params);
}

async function withPgTx(sdk, fn) {
  const pool = getPgPool(sdk);
  if (!pool) throw new Error('Postgres not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

async function tryExecMigrationsSqlite(sdk) {
  const db = sdk?.db;
  if (!db) return;

  const exec =
    (typeof db.exec === 'function' && db.exec.bind(db)) ||
    (typeof db.run === 'function' && db.run.bind(db)) ||
    null;

  if (!exec) return;

  for (const sql of SQLITE_MIGRATIONS) {
    try {
      await exec(sql);
    } catch {
      // best-effort for varying Teleton adapters
    }
  }
}

async function tryExecMigrationsPg(sdk) {
  const pool = getPgPool(sdk);
  if (!pool) return false;
  for (const sql of BASE_MIGRATIONS) {
    await pool.query(sql);
  }
  return true;
}

async function tryVerifySupabaseSchema(sdk) {
  if (!hasSupabaseRestConfig(sdk)) return false;

  const requiredTables = ['peers', 'intents', 'offers', 'deals', 'processed_messages'];
  for (const table of requiredTables) {
    const res = await supabaseRequest(sdk, {
      method: 'GET',
      path: table,
      query: { select: '*', limit: 0 },
      allow404: true,
    });
    if (!res.ok && res.status === 404) {
      const err = new Error(
        `Supabase table "${table}" not found. Apply SQL schema in Supabase SQL Editor before starting MESH.`,
      );
      err.code = 'MESH_SUPABASE_SCHEMA_MISSING';
      throw err;
    }
  }
  return true;
}

function mapPeerRow(row) {
  if (!row) return null;
  return {
    address: row.address,
    skills: Array.isArray(row.skills) ? row.skills : parseMaybeJson(row.skills, []),
    minFee: toNum(row.min_fee ?? row.minfee),
    responseTime: row.response_time ?? row.responsetime ?? '< 5s',
    reputation: toInt(row.reputation, 100),
    stake: toNum(row.stake),
    stakeAgeSeconds: toInt(row.stake_age_seconds),
    replyChat: row.reply_chat ?? null,
    lastSeen: toInt(row.last_seen),
    createdAt: toInt(row.created_at),
    updatedAt: toInt(row.updated_at),
  };
}

function mapIntentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromAddress: row.from_address,
    skill: row.skill,
    payload: parseMaybeJson(row.payload, {}),
    budget: toNum(row.budget),
    deadline: toInt(row.deadline),
    minReputation: toInt(row.min_reputation),
    status: row.status,
    createdAt: toInt(row.created_at),
    acceptedOfferId: row.accepted_offer_id ?? null,
    selectedExecutor: row.selected_executor ?? null,
    updatedAt: toInt(row.updated_at),
  };
}

function mapOfferRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    intentId: row.intent_id,
    fromAddress: row.from_address,
    fee: toNum(row.fee),
    feeRaw: row.fee_raw ?? String(row.fee ?? 0),
    eta: row.eta,
    reputation: row.reputation == null ? null : toInt(row.reputation),
    stakeAgeSeconds: toInt(row.stake_age_seconds),
    escrowAddress: row.escrow_address ?? null,
    createdAt: toInt(row.created_at),
  };
}

function mapDealRow(row) {
  if (!row) return null;
  return {
    intentId: row.intent_id,
    executorAddress: row.executor_address ?? null,
    fee: row.fee == null ? null : toNum(row.fee),
    txHash: row.tx_hash ?? null,
    outcome: row.outcome ?? null,
    rating: row.rating == null ? null : toInt(row.rating),
    settledAt: row.settled_at == null ? null : toInt(row.settled_at),
    updatedAt: row.updated_at == null ? null : toInt(row.updated_at),
  };
}

export async function migrate(sdk, options = {}) {
  setRuntimeConfig(sdk, options.config || options);
  ensureStore(sdk);

  const usedSupabase = await tryVerifySupabaseSchema(sdk).catch((err) => {
    getLogger(sdk).error?.('[MESH] Supabase schema verification failed', err);
    throw err;
  });
  if (usedSupabase) {
    return BASE_MIGRATIONS.slice();
  }

  const usedPg = await tryExecMigrationsPg(sdk).catch((err) => {
    getLogger(sdk).error?.('[MESH] Postgres migration failed', err);
    throw err;
  });

  if (!usedPg) {
    await tryExecMigrationsSqlite(sdk);
  }

  return BASE_MIGRATIONS.slice();
}

export function migrations() {
  return BASE_MIGRATIONS.slice();
}

export async function upsertPeer(sdk, peer) {
  const ts = now();
  if (hasSupabaseRestConfig(sdk)) {
    const existing = await getPeer(sdk, peer.address);
    const record = {
      address: peer.address,
      skills: Array.isArray(peer.skills) ? peer.skills.slice() : (existing?.skills ?? []),
      min_fee: peer.minFee == null ? (existing?.minFee ?? 0) : toNum(peer.minFee),
      response_time: peer.responseTime ?? existing?.responseTime ?? '< 5s',
      reputation: Number.isFinite(peer.reputation) ? peer.reputation : (existing?.reputation ?? 100),
      stake: peer.stake == null ? (existing?.stake ?? 0) : toNum(peer.stake),
      stake_age_seconds: Number.isFinite(peer.stakeAgeSeconds) ? peer.stakeAgeSeconds : (existing?.stakeAgeSeconds ?? 0),
      reply_chat: peer.replyChat == null ? (existing?.replyChat ?? null) : String(peer.replyChat),
      last_seen: peer.lastSeen ?? ts,
      created_at: existing?.createdAt ?? ts,
      updated_at: ts,
    };
    const row = await supabaseUpsertOne(sdk, 'peers', record, 'address');
    return mapPeerRow(row);
  }

  const pool = getPgPool(sdk);
  if (pool) {
    const existing = await getPeer(sdk, peer.address);
    const record = {
      address: peer.address,
      skills: Array.isArray(peer.skills) ? peer.skills.slice() : (existing?.skills ?? []),
      minFee: peer.minFee == null ? (existing?.minFee ?? 0) : toNum(peer.minFee),
      responseTime: peer.responseTime ?? existing?.responseTime ?? '< 5s',
      reputation: Number.isFinite(peer.reputation) ? peer.reputation : (existing?.reputation ?? 100),
      stake: peer.stake == null ? (existing?.stake ?? 0) : toNum(peer.stake),
      stakeAgeSeconds: Number.isFinite(peer.stakeAgeSeconds) ? peer.stakeAgeSeconds : (existing?.stakeAgeSeconds ?? 0),
      replyChat: peer.replyChat ?? existing?.replyChat ?? null,
      lastSeen: peer.lastSeen ?? ts,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };

    const { rows } = await queryPg(
      sdk,
      `INSERT INTO peers (
         address, skills, min_fee, response_time, reputation, stake, stake_age_seconds,
         reply_chat, last_seen, created_at, updated_at
       ) VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (address) DO UPDATE SET
         skills = EXCLUDED.skills,
         min_fee = EXCLUDED.min_fee,
         response_time = EXCLUDED.response_time,
         reputation = EXCLUDED.reputation,
         stake = EXCLUDED.stake,
         stake_age_seconds = EXCLUDED.stake_age_seconds,
         reply_chat = EXCLUDED.reply_chat,
         last_seen = EXCLUDED.last_seen,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        record.address,
        JSON.stringify(record.skills),
        record.minFee,
        record.responseTime,
        record.reputation,
        record.stake,
        record.stakeAgeSeconds,
        record.replyChat == null ? null : String(record.replyChat),
        record.lastSeen,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return mapPeerRow(rows[0]);
  }

  const store = ensureStore(sdk);
  const existing = store.peers.get(peer.address) || {};
  const record = {
    address: peer.address,
    skills: Array.isArray(peer.skills) ? peer.skills.slice() : (existing.skills || []),
    minFee: toNum(peer.minFee, toNum(existing.minFee, 0)),
    responseTime: peer.responseTime ?? existing.responseTime ?? '< 5s',
    reputation: Number.isFinite(peer.reputation) ? peer.reputation : (existing.reputation ?? 100),
    lastSeen: peer.lastSeen ?? ts,
    stake: toNum(peer.stake, toNum(existing.stake, 0)),
    stakeAgeSeconds: Number.isFinite(peer.stakeAgeSeconds) ? peer.stakeAgeSeconds : (existing.stakeAgeSeconds ?? 0),
    replyChat: peer.replyChat ?? existing.replyChat ?? null,
    createdAt: existing.createdAt ?? ts,
    updatedAt: ts,
  };
  store.peers.set(record.address, record);
  return record;
}

export async function getPeer(sdk, address) {
  if (hasSupabaseRestConfig(sdk)) {
    const row = await supabaseSelectOne(sdk, 'peers', { address: encodeEq(address) });
    return mapPeerRow(row);
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(sdk, 'SELECT * FROM peers WHERE address = $1 LIMIT 1', [address]);
    return mapPeerRow(rows[0]);
  }
  return ensureStore(sdk).peers.get(address) || null;
}

export async function listPeers(sdk) {
  if (hasSupabaseRestConfig(sdk)) {
    const { data } = await supabaseRequest(sdk, {
      method: 'GET',
      path: 'peers',
      query: { select: '*', order: 'last_seen.desc.nullslast' },
    });
    return Array.isArray(data) ? data.map(mapPeerRow) : [];
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(sdk, 'SELECT * FROM peers ORDER BY last_seen DESC NULLS LAST');
    return rows.map(mapPeerRow);
  }
  return Array.from(ensureStore(sdk).peers.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

export async function saveIntent(sdk, intent) {
  const ts = now();
  if (hasSupabaseRestConfig(sdk)) {
    const existing = await getIntent(sdk, intent.id);
    const record = {
      id: intent.id,
      from_address: intent.fromAddress ?? existing?.fromAddress ?? null,
      skill: intent.skill ?? existing?.skill ?? null,
      payload: intent.payload ?? existing?.payload ?? {},
      budget: intent.budget == null ? (existing?.budget ?? 0) : toNum(intent.budget),
      deadline: intent.deadline ?? existing?.deadline ?? null,
      min_reputation: Number.isFinite(intent.minReputation) ? intent.minReputation : (existing?.minReputation ?? 0),
      status: intent.status ?? existing?.status ?? 'pending',
      created_at: intent.createdAt ?? existing?.createdAt ?? ts,
      accepted_offer_id: intent.acceptedOfferId ?? existing?.acceptedOfferId ?? null,
      selected_executor: intent.selectedExecutor ?? existing?.selectedExecutor ?? null,
      updated_at: ts,
    };
    const row = await supabaseUpsertOne(sdk, 'intents', record, 'id');
    return mapIntentRow(row);
  }

  const pool = getPgPool(sdk);
  if (pool) {
    const existing = await getIntent(sdk, intent.id);
    const record = {
      id: intent.id,
      fromAddress: intent.fromAddress ?? existing?.fromAddress,
      skill: intent.skill ?? existing?.skill,
      payload: intent.payload ?? existing?.payload ?? {},
      budget: intent.budget == null ? (existing?.budget ?? 0) : toNum(intent.budget),
      deadline: intent.deadline ?? existing?.deadline,
      minReputation: Number.isFinite(intent.minReputation) ? intent.minReputation : (existing?.minReputation ?? 0),
      status: intent.status ?? existing?.status ?? 'pending',
      createdAt: intent.createdAt ?? existing?.createdAt ?? ts,
      acceptedOfferId: intent.acceptedOfferId ?? existing?.acceptedOfferId ?? null,
      selectedExecutor: intent.selectedExecutor ?? existing?.selectedExecutor ?? null,
      updatedAt: ts,
    };

    const { rows } = await queryPg(
      sdk,
      `INSERT INTO intents (
         id, from_address, skill, payload, budget, deadline, min_reputation,
         status, created_at, accepted_offer_id, selected_executor, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         from_address = EXCLUDED.from_address,
         skill = EXCLUDED.skill,
         payload = EXCLUDED.payload,
         budget = EXCLUDED.budget,
         deadline = EXCLUDED.deadline,
         min_reputation = EXCLUDED.min_reputation,
         status = EXCLUDED.status,
         accepted_offer_id = EXCLUDED.accepted_offer_id,
         selected_executor = EXCLUDED.selected_executor,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        record.id,
        record.fromAddress,
        record.skill,
        JSON.stringify(record.payload),
        record.budget,
        record.deadline,
        record.minReputation,
        record.status,
        record.createdAt,
        record.acceptedOfferId,
        record.selectedExecutor,
        record.updatedAt,
      ],
    );
    return mapIntentRow(rows[0]);
  }

  const store = ensureStore(sdk);
  const existing = store.intents.get(intent.id);
  const record = {
    id: intent.id,
    fromAddress: intent.fromAddress,
    skill: intent.skill,
    payload: intent.payload ?? {},
    budget: toNum(intent.budget),
    deadline: intent.deadline,
    minReputation: Number.isFinite(intent.minReputation) ? intent.minReputation : 0,
    status: intent.status ?? existing?.status ?? 'pending',
    createdAt: intent.createdAt ?? existing?.createdAt ?? ts,
    acceptedOfferId: intent.acceptedOfferId ?? existing?.acceptedOfferId ?? null,
    selectedExecutor: intent.selectedExecutor ?? existing?.selectedExecutor ?? null,
    updatedAt: ts,
  };
  store.intents.set(record.id, record);
  return record;
}

export async function getIntent(sdk, id) {
  if (hasSupabaseRestConfig(sdk)) {
    const row = await supabaseSelectOne(sdk, 'intents', { id: encodeEq(id) });
    return mapIntentRow(row);
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(sdk, 'SELECT * FROM intents WHERE id = $1 LIMIT 1', [id]);
    return mapIntentRow(rows[0]);
  }
  return ensureStore(sdk).intents.get(id) || null;
}

export async function listIntents(sdk, { status } = {}) {
  if (hasSupabaseRestConfig(sdk)) {
    const query = { select: '*', order: 'created_at.desc' };
    if (status) query.status = encodeEq(status);
    const { data } = await supabaseRequest(sdk, {
      method: 'GET',
      path: 'intents',
      query,
    });
    return Array.isArray(data) ? data.map(mapIntentRow) : [];
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = status
      ? await queryPg(sdk, 'SELECT * FROM intents WHERE status = $1 ORDER BY created_at DESC', [status])
      : await queryPg(sdk, 'SELECT * FROM intents ORDER BY created_at DESC');
    return rows.map(mapIntentRow);
  }

  const all = Array.from(ensureStore(sdk).intents.values());
  return status ? all.filter((item) => item.status === status) : all;
}

export async function updateIntentStatus(sdk, id, status, extra = {}) {
  if (hasSupabaseRestConfig(sdk)) {
    const current = await getIntent(sdk, id);
    if (!current) return null;
    return saveIntent(sdk, {
      ...current,
      status,
      ...extra,
    });
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const current = await getIntent(sdk, id);
    if (!current) return null;
    return saveIntent(sdk, {
      ...current,
      status,
      ...extra,
    });
  }

  const store = ensureStore(sdk);
  const current = store.intents.get(id);
  if (!current) return null;
  const updated = { ...current, status, ...extra, updatedAt: now() };
  store.intents.set(id, updated);
  return updated;
}

export async function acceptIntentOffer(sdk, intentId, offerId, executorAddress) {
  if (hasSupabaseRestConfig(sdk)) {
    const ts = now();
    const { data } = await supabaseRequest(sdk, {
      method: 'PATCH',
      path: 'intents',
      query: { id: encodeEq(intentId), status: encodeEq('pending'), select: '*' },
      body: {
        status: 'accepted',
        accepted_offer_id: offerId,
        selected_executor: executorAddress,
        updated_at: ts,
      },
      prefer: 'return=representation',
    });
    if (Array.isArray(data) && data.length > 0) {
      return { ok: true, intent: mapIntentRow(data[0]) };
    }
    const current = await getIntent(sdk, intentId);
    if (!current) return { ok: false, reason: 'intent_not_found' };
    if (current.status !== 'pending') return { ok: false, reason: 'intent_not_pending', intent: current };
    return { ok: false, reason: 'intent_accept_failed', intent: current };
  }

  const pool = getPgPool(sdk);
  if (pool) {
    return withPgTx(sdk, async (client) => {
      const { rows } = await queryPg(sdk, 'SELECT * FROM intents WHERE id = $1 FOR UPDATE', [intentId], client);
      if (rows.length === 0) return { ok: false, reason: 'intent_not_found' };
      const current = mapIntentRow(rows[0]);
      if (current.status !== 'pending') return { ok: false, reason: 'intent_not_pending', intent: current };

      const ts = now();
      const { rows: updatedRows } = await queryPg(
        sdk,
        `UPDATE intents
         SET status = 'accepted', accepted_offer_id = $2, selected_executor = $3, updated_at = $4
         WHERE id = $1
         RETURNING *`,
        [intentId, offerId, executorAddress, ts],
        client,
      );
      return { ok: true, intent: mapIntentRow(updatedRows[0]) };
    });
  }

  const current = await getIntent(sdk, intentId);
  if (!current) return { ok: false, reason: 'intent_not_found' };
  if (current.status !== 'pending') return { ok: false, reason: 'intent_not_pending', intent: current };
  const updated = await updateIntentStatus(sdk, intentId, 'accepted', {
    acceptedOfferId: offerId,
    selectedExecutor: executorAddress,
  });
  return { ok: true, intent: updated };
}

export async function recordOffer(sdk, offer) {
  const id = offer.id ?? `${offer.intentId}:${offer.fromAddress}:${offer.createdAt ?? now()}`;
  const record = {
    id,
    intentId: offer.intentId,
    fromAddress: offer.fromAddress,
    fee: toNum(offer.fee),
    feeRaw: String(offer.fee),
    eta: offer.eta,
    reputation: Number.isFinite(offer.reputation) ? offer.reputation : null,
    stakeAgeSeconds: Number.isFinite(offer.stakeAgeSeconds) ? offer.stakeAgeSeconds : 0,
    escrowAddress: offer.escrowAddress ?? null,
    createdAt: offer.createdAt ?? now(),
  };

  if (hasSupabaseRestConfig(sdk)) {
    const row = await supabaseUpsertOne(sdk, 'offers', {
      id: record.id,
      intent_id: record.intentId,
      from_address: record.fromAddress,
      fee: record.fee,
      fee_raw: record.feeRaw,
      eta: record.eta,
      reputation: record.reputation,
      stake_age_seconds: record.stakeAgeSeconds,
      escrow_address: record.escrowAddress,
      created_at: record.createdAt,
    }, 'id');
    return mapOfferRow(row);
  }

  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(
      sdk,
      `INSERT INTO offers (
         id, intent_id, from_address, fee, fee_raw, eta, reputation,
         stake_age_seconds, escrow_address, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         fee = EXCLUDED.fee,
         fee_raw = EXCLUDED.fee_raw,
         eta = EXCLUDED.eta,
         reputation = EXCLUDED.reputation,
         stake_age_seconds = EXCLUDED.stake_age_seconds,
         escrow_address = EXCLUDED.escrow_address
       RETURNING *`,
      [
        record.id,
        record.intentId,
        record.fromAddress,
        record.fee,
        record.feeRaw,
        record.eta,
        record.reputation,
        record.stakeAgeSeconds,
        record.escrowAddress,
        record.createdAt,
      ],
    );
    return mapOfferRow(rows[0]);
  }

  ensureStore(sdk).offers.set(record.id, record);
  return record;
}

export async function listOffersForIntent(sdk, intentId) {
  if (hasSupabaseRestConfig(sdk)) {
    const { data } = await supabaseRequest(sdk, {
      method: 'GET',
      path: 'offers',
      query: { select: '*', intent_id: encodeEq(intentId), order: 'created_at.asc' },
    });
    return Array.isArray(data) ? data.map(mapOfferRow) : [];
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(
      sdk,
      'SELECT * FROM offers WHERE intent_id = $1 ORDER BY created_at ASC',
      [intentId],
    );
    return rows.map(mapOfferRow);
  }

  return Array.from(ensureStore(sdk).offers.values())
    .filter((offer) => offer.intentId === intentId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function settleDeal(sdk, deal) {
  const existing = await getDeal(sdk, deal.intentId);
  const ts = now();
  const record = {
    intentId: deal.intentId,
    executorAddress: deal.executorAddress ?? existing?.executorAddress ?? null,
    fee: deal.fee == null ? (existing?.fee ?? null) : toNum(deal.fee),
    txHash: deal.txHash ?? existing?.txHash ?? null,
    outcome: deal.outcome ?? existing?.outcome ?? null,
    rating: Number.isFinite(deal.rating) ? deal.rating : (existing?.rating ?? null),
    settledAt: deal.settledAt ?? (deal.outcome ? now() : (existing?.settledAt ?? null)),
    updatedAt: ts,
  };

  if (hasSupabaseRestConfig(sdk)) {
    const row = await supabaseUpsertOne(sdk, 'deals', {
      intent_id: record.intentId,
      executor_address: record.executorAddress,
      fee: record.fee,
      tx_hash: record.txHash,
      outcome: record.outcome,
      rating: record.rating,
      settled_at: record.settledAt,
      updated_at: record.updatedAt,
    }, 'intent_id');
    return mapDealRow(row);
  }

  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(
      sdk,
      `INSERT INTO deals (
         intent_id, executor_address, fee, tx_hash, outcome, rating, settled_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (intent_id) DO UPDATE SET
         executor_address = EXCLUDED.executor_address,
         fee = EXCLUDED.fee,
         tx_hash = EXCLUDED.tx_hash,
         outcome = EXCLUDED.outcome,
         rating = EXCLUDED.rating,
         settled_at = EXCLUDED.settled_at,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        record.intentId,
        record.executorAddress,
        record.fee,
        record.txHash,
        record.outcome,
        record.rating,
        record.settledAt,
        record.updatedAt,
      ],
    );
    return mapDealRow(rows[0]);
  }

  ensureStore(sdk).deals.set(record.intentId, record);
  return record;
}

export async function getDeal(sdk, intentId) {
  if (hasSupabaseRestConfig(sdk)) {
    const row = await supabaseSelectOne(sdk, 'deals', { intent_id: encodeEq(intentId) });
    return mapDealRow(row);
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(sdk, 'SELECT * FROM deals WHERE intent_id = $1 LIMIT 1', [intentId]);
    return mapDealRow(rows[0]);
  }
  return ensureStore(sdk).deals.get(intentId) || null;
}

export async function listDeals(sdk) {
  if (hasSupabaseRestConfig(sdk)) {
    const { data } = await supabaseRequest(sdk, {
      method: 'GET',
      path: 'deals',
      query: { select: '*', order: 'settled_at.desc.nullslast' },
    });
    return Array.isArray(data) ? data.map(mapDealRow) : [];
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(sdk, 'SELECT * FROM deals ORDER BY settled_at DESC NULLS LAST');
    return rows.map(mapDealRow);
  }
  return Array.from(ensureStore(sdk).deals.values()).sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0));
}

export async function expireIntents(sdk, ts = now()) {
  if (hasSupabaseRestConfig(sdk)) {
    const { data } = await supabaseRequest(sdk, {
      method: 'PATCH',
      path: 'intents',
      query: { status: encodeEq('pending'), deadline: encodeLt(ts), select: '*' },
      body: { status: 'expired', updated_at: now() },
      prefer: 'return=representation',
    });
    return Array.isArray(data) ? data.map(mapIntentRow) : [];
  }
  const pool = getPgPool(sdk);
  if (pool) {
    const { rows } = await queryPg(
      sdk,
      `UPDATE intents
       SET status = 'expired', updated_at = $2
       WHERE status = 'pending' AND deadline < $1
       RETURNING *`,
      [ts, now()],
    );
    return rows.map(mapIntentRow);
  }

  const store = ensureStore(sdk);
  const expired = [];
  for (const [id, intent] of store.intents.entries()) {
    if (intent.status === 'pending' && intent.deadline < ts) {
      const next = { ...intent, status: 'expired', updatedAt: now() };
      store.intents.set(id, next);
      expired.push(next);
    }
  }
  return expired;
}

export async function hasSkill(sdk, address, skill) {
  const peer = await getPeer(sdk, address);
  if (!peer) return false;
  return (peer.skills || []).includes(skill);
}

export async function markProcessedMessage(sdk, meta) {
  const key = meta?.key;
  if (!key) throw new Error('processed message key is required');

  if (hasSupabaseRestConfig(sdk)) {
    const insertedRows = await supabaseInsertIgnoreDuplicate(sdk, 'processed_messages', {
      message_key: key,
      message_type: meta.messageType ?? null,
      source_chat_id: meta.sourceChatId == null ? null : String(meta.sourceChatId),
      source_message_id: meta.sourceMessageId == null ? null : String(meta.sourceMessageId),
      payload_hash: meta.payloadHash ?? null,
      first_seen_at: meta.firstSeenAt ?? now(),
    });
    return { inserted: insertedRows.length > 0 };
  }

  const pool = getPgPool(sdk);
  if (pool) {
    const { rowCount } = await queryPg(
      sdk,
      `INSERT INTO processed_messages (
         message_key, message_type, source_chat_id, source_message_id, payload_hash, first_seen_at
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (message_key) DO NOTHING`,
      [
        key,
        meta.messageType ?? null,
        meta.sourceChatId == null ? null : String(meta.sourceChatId),
        meta.sourceMessageId == null ? null : String(meta.sourceMessageId),
        meta.payloadHash ?? null,
        meta.firstSeenAt ?? now(),
      ],
    );
    return { inserted: rowCount === 1 };
  }

  const store = ensureStore(sdk);
  if (store.processedMessages.has(key)) {
    return { inserted: false };
  }
  store.processedMessages.add(key);
  return { inserted: true };
}

export async function closeRegistry(sdk) {
  if (sdk?.__meshPgPool) {
    const pool = sdk.__meshPgPool;
    sdk.__meshPgPool = null;
    await pool.end();
  }
}
