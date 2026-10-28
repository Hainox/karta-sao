import { Pool } from 'pg';

// pg-pool re-emits errors of idle clients (e.g. the database restarted or ran out of disk).
// Without a listener Node treats that as an unhandled 'error' event and the whole service
// exits; with one the broken client is dropped and the next query opens a fresh connection.
export function createDatabasePool(config, { log = console.error } = {}) {
  const pool = new Pool(config);
  pool.on('error', (error) => log(`Database connection lost, will reconnect on next query: ${error.message}`));
  return pool;
}
