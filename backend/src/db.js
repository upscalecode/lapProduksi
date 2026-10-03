import 'dotenv/config';
import pg from 'pg';

const ssl = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true'
  ? { rejectUnauthorized: false }
  : false;

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl });

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
