// ─── Conexión a PostgreSQL ───
// Un solo "pool" de conexiones reutilizable por toda la app.
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// En la nube (Railway, Render, etc.) la conexión suele requerir SSL.
// Detectamos si estamos en producción para activarlo automáticamente.
const enProduccion = process.env.NODE_ENV === 'production' || process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: enProduccion ? { rejectUnauthorized: false } : false,
});

// Pequeño ayudante para hacer queries con menos código.
export async function query(text, params) {
  return pool.query(text, params);
}
