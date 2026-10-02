import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

// Postgres перезапустили — пул сам переподключится. Без обработчика такая ошибка роняет процесс.
pool.on('error', err => console.error('pg pool error:', err.message));

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
