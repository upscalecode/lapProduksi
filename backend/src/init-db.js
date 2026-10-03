import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const sqlUrl = new URL('../sql/001_schema.sql', import.meta.url);
await pool.query(await fs.readFile(fileURLToPath(sqlUrl), 'utf8'));
console.log('Skema PostgreSQL siap.');
await pool.end();
