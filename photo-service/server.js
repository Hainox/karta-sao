import { createServer } from 'node:http';
import { Pool } from 'pg';
import { photoServiceDatabaseConfig } from './src/config.js';
import { createHealthHandler } from './src/health.js';

const port = 8788;
const pool = new Pool({
  ...photoServiceDatabaseConfig(process.env),
  max: 4,
  idleTimeoutMillis: 30000,
});

const server = createServer(createHealthHandler({
  probeDatabase: async () => {
    await pool.query('SELECT 1');
  },
}));

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '0.0.0.0', resolve);
});

console.log('SAO photo service listening on port ' + port);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;

  server.close(async (error) => {
    try {
      await pool.end();
      if (error) {
        console.error('Photo service shutdown failed');
        process.exitCode = 1;
      }
    } catch {
      console.error('Photo service database shutdown failed');
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
