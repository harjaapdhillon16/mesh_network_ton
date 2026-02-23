import { closeRegistry, migrate } from '../registry.js';

const supabaseUrl = process.env.MESH_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.MESH_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('Missing MESH_SUPABASE_URL and/or MESH_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sdk = {
  logger: console,
  __meshRuntimeConfig: {
    supabaseUrl,
    supabaseServiceRoleKey,
  },
};

try {
  await migrate(sdk, { config: sdk.__meshRuntimeConfig });
  console.log('Supabase schema verified for MESH tables.');
} catch (err) {
  console.error('Supabase schema verification failed:', err?.message || err);
  if (err?.code === 'MESH_SUPABASE_SCHEMA_MISSING') {
    console.error('Run the SQL in plugin/mesh/supabase/schema.sql in Supabase SQL Editor, then rerun this check.');
  }
  if (err?.response) {
    console.error(JSON.stringify(err.response, null, 2));
  }
  process.exitCode = 1;
} finally {
  await closeRegistry(sdk).catch(() => {});
}
