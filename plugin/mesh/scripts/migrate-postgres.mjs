import { migrate, closeRegistry } from '../registry.js';

const databaseUrl = process.env.MESH_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Missing MESH_DATABASE_URL (or DATABASE_URL)');
  process.exit(1);
}

const sdk = {
  logger: console,
  __meshRuntimeConfig: {
    databaseUrl,
    dbSsl: process.env.MESH_DB_SSL === 'false' ? false : true,
    dbPoolMax: process.env.MESH_DB_POOL_MAX ? Number(process.env.MESH_DB_POOL_MAX) : 5,
  },
};

try {
  const statements = await migrate(sdk, { config: sdk.__meshRuntimeConfig });
  console.log(`MESH Postgres migrations applied: ${statements.length}`);
} catch (err) {
  console.error('Migration failed:', err?.message || err);
  process.exitCode = 1;
} finally {
  await closeRegistry(sdk).catch(() => {});
}
