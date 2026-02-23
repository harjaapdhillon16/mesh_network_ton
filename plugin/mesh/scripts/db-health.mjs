import { closeRegistry, migrate, listDeals, listIntents, listPeers } from '../registry.js';

const databaseUrl = process.env.MESH_DATABASE_URL || process.env.DATABASE_URL;
const supabaseUrl = process.env.MESH_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.MESH_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!databaseUrl && !(supabaseUrl && supabaseServiceRoleKey)) {
  console.error('Missing DB config. Set MESH_DATABASE_URL or (MESH_SUPABASE_URL + MESH_SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const sdk = {
  logger: console,
  __meshRuntimeConfig: {
    databaseUrl,
    supabaseUrl,
    supabaseServiceRoleKey,
    dbSsl: process.env.MESH_DB_SSL === 'false' ? false : true,
    dbPoolMax: 2,
  },
};

try {
  await migrate(sdk, { config: sdk.__meshRuntimeConfig });
  const [peers, intents, deals] = await Promise.all([
    listPeers(sdk),
    listIntents(sdk),
    listDeals(sdk),
  ]);
  console.log(JSON.stringify({
    ok: true,
    peers: peers.length,
    intents: intents.length,
    deals: deals.length,
    mode: databaseUrl ? 'postgres' : 'supabase-rest',
  }, null, 2));
} catch (err) {
  console.error('DB health check failed:', err?.message || err);
  if (err?.response) {
    console.error(JSON.stringify(err.response, null, 2));
  }
  process.exitCode = 1;
} finally {
  await closeRegistry(sdk).catch(() => {});
}
