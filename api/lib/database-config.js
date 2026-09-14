export function databasePoolOptions(env = process.env) {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  if (env.PGHOST && env.PGDATABASE && env.PGUSER) return {};
  throw new Error('Задайте DATABASE_URL или PGHOST, PGDATABASE и PGUSER.');
}
