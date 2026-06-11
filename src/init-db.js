// ─── Inicialización de la base de datos ───
// Crea las tablas y carga los datos iniciales (los mismos del demo).
// Se puede ejecutar solo (npm run init-db) o ser llamado por el servidor al arrancar.
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  usuario     TEXT UNIQUE NOT NULL,
  email       TEXT,
  avatar      TEXT,
  rol         TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  permisos    TEXT[] NOT NULL DEFAULT '{}',
  creado_en   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entidades (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  tipo        TEXT,
  handles     TEXT,
  keywords    TEXT,
  icono       TEXT,
  es_base     BOOLEAN DEFAULT false,
  creado_en   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS proyectos (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  aceptacion  INTEGER DEFAULT 50,
  menciones   INTEGER DEFAULT 0,
  pos         INTEGER DEFAULT 0,
  neg         INTEGER DEFAULT 0,
  neu         INTEGER DEFAULT 0,
  tendencia   INTEGER[] DEFAULT '{}',
  creado_en   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auditoria (
  id          SERIAL PRIMARY KEY,
  etiqueta    TEXT,
  texto       TEXT,
  usuario     TEXT,
  creado_en   TIMESTAMPTZ DEFAULT now()
);
-- Cada vez que se sube un archivo .xlsx queda registrada la carga (para histórico)
CREATE TABLE IF NOT EXISTS cargas (
  id            SERIAL PRIMARY KEY,
  archivo       TEXT,
  fuente_url    TEXT,
  total         INTEGER DEFAULT 0,
  positivos     INTEGER DEFAULT 0,
  negativos     INTEGER DEFAULT 0,
  neutros       INTEGER DEFAULT 0,
  dudosos       INTEGER DEFAULT 0,
  subido_por    TEXT,
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Cada comentario individual con su clasificación
CREATE TABLE IF NOT EXISTS menciones (
  id            SERIAL PRIMARY KEY,
  carga_id      INTEGER REFERENCES cargas(id) ON DELETE CASCADE,
  autor         TEXT,
  profile_id    TEXT,
  username      TEXT,
  red           TEXT,            -- Facebook | Instagram | TikTok | X
  fecha         TIMESTAMPTZ,
  likes         INTEGER DEFAULT 0,
  texto         TEXT,
  permalink     TEXT,
  sentimiento   TEXT,            -- 'positivo' | 'negativo' | 'neutro'
  confianza     REAL DEFAULT 0,  -- 0 a 1; bajo = dudoso, lo revisa una persona
  revisado      BOOLEAN DEFAULT false,
  zona          TEXT,            -- zona detectada en el texto (si aplica)
  dolor         TEXT,            -- "dolor" detectado en el texto
  -- datos forenses (sobre todo de X/Twitter)
  followers     INTEGER,
  bio           TEXT,
  ubicacion     TEXT,
  verificado    BOOLEAN,
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Por si la tabla ya existía, agrega las columnas nuevas sin perder datos
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS red TEXT;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS dolor TEXT;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS followers INTEGER;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS ubicacion TEXT;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS verificado BOOLEAN;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE menciones ADD COLUMN IF NOT EXISTS senalado TEXT;
CREATE INDEX IF NOT EXISTS idx_menciones_carga ON menciones(carga_id);
CREATE INDEX IF NOT EXISTS idx_menciones_sent ON menciones(sentimiento);
CREATE INDEX IF NOT EXISTS idx_menciones_dudoso ON menciones(revisado) WHERE confianza < 0.6;
-- Sentimiento mensual histórico por entidad (ingresado a mano)
CREATE TABLE IF NOT EXISTS sentimiento_mensual (
  id          SERIAL PRIMARY KEY,
  entidad_id  INTEGER REFERENCES entidades(id) ON DELETE CASCADE,
  anio        INTEGER NOT NULL,
  mes         INTEGER NOT NULL,
  positivo    INTEGER DEFAULT 0,
  negativo    INTEGER DEFAULT 0,
  neutro      INTEGER DEFAULT 0,
  creado_en   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entidad_id, anio, mes)
);
-- Actores monitoreados: medios, políticos, empresarios
CREATE TABLE IF NOT EXISTS actores (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  tipo          TEXT DEFAULT 'medio',           -- 'medio' | 'politico' | 'empresario'
  postura       TEXT DEFAULT 'neutral',          -- 'favor' | 'contra' | 'neutral'
  redes         TEXT,                             -- handles / links de redes
  notas         TEXT,                             -- observaciones del usuario
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Publicaciones con sus métricas (de la plantilla de Excel)
CREATE TABLE IF NOT EXISTS publicaciones (
  id            SERIAL PRIMARY KEY,
  fecha         DATE,
  red           TEXT,
  tema          TEXT,
  texto         TEXT,
  alcance       BIGINT DEFAULT 0,
  plays         BIGINT DEFAULT 0,
  likes         BIGINT DEFAULT 0,
  comentarios   BIGINT DEFAULT 0,
  compartidos   BIGINT DEFAULT 0,
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Credibilidad por entidad (de la plantilla)
CREATE TABLE IF NOT EXISTS credibilidad (
  id            SERIAL PRIMARY KEY,
  entidad       TEXT UNIQUE NOT NULL,
  puntaje       INTEGER DEFAULT 0,
  respuesta     INTEGER DEFAULT 0,
  transparencia INTEGER DEFAULT 0,
  consistencia  INTEGER DEFAULT 0,
  cercania      INTEGER DEFAULT 0,
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Zonas críticas (de la plantilla)
CREATE TABLE IF NOT EXISTS zonas (
  id            SERIAL PRIMARY KEY,
  zona          TEXT UNIQUE NOT NULL,
  menciones     INTEGER DEFAULT 0,
  nota          TEXT,
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Crisis diaria (menciones por día) para el radar
CREATE TABLE IF NOT EXISTS crisis_diaria (
  id            SERIAL PRIMARY KEY,
  fecha         DATE UNIQUE,
  menciones     INTEGER DEFAULT 0
);
-- Engagement rate por canal
CREATE TABLE IF NOT EXISTS engagement_canal (
  id            SERIAL PRIMARY KEY,
  canal         TEXT UNIQUE NOT NULL,
  er            NUMERIC DEFAULT 0
);
-- Sentimiento por tema (gráfica de estadísticas)
CREATE TABLE IF NOT EXISTS sentimiento_tema (
  id            SERIAL PRIMARY KEY,
  tema          TEXT UNIQUE NOT NULL,
  positivos     INTEGER DEFAULT 0,
  negativos     INTEGER DEFAULT 0,
  neutros       INTEGER DEFAULT 0
);
-- Sentimiento semanal (positivos vs negativos por semana)
CREATE TABLE IF NOT EXISTS sentimiento_semanal (
  id            SERIAL PRIMARY KEY,
  semana        TEXT UNIQUE NOT NULL,
  positivos     INTEGER DEFAULT 0,
  negativos     INTEGER DEFAULT 0
);
-- Denuncias ciudadanas concretas
CREATE TABLE IF NOT EXISTS denuncias (
  id            SERIAL PRIMARY KEY,
  fecha         DATE,
  zona          TEXT,
  tipo          TEXT,
  descripcion   TEXT,
  estado        TEXT DEFAULT 'Pendiente',
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Proyectos con métricas (de la plantilla; complementa la tabla proyectos existente)
CREATE TABLE IF NOT EXISTS proyectos_metricas (
  id            SERIAL PRIMARY KEY,
  proyecto      TEXT UNIQUE NOT NULL,
  aceptacion    INTEGER DEFAULT 0,
  menciones     INTEGER DEFAULT 0,
  positivo      INTEGER DEFAULT 0,
  negativo      INTEGER DEFAULT 0,
  tendencia     INTEGER DEFAULT 0
);
-- Fuentes RSS (Google Alerts) que el usuario registra
CREATE TABLE IF NOT EXISTS fuentes_rss (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  url           TEXT NOT NULL,
  activa        BOOLEAN DEFAULT true,
  creado_en     TIMESTAMPTZ DEFAULT now()
);
-- Menciones detectadas de los feeds (las alertas)
CREATE TABLE IF NOT EXISTS menciones_alertas (
  id            SERIAL PRIMARY KEY,
  fuente_id     INTEGER REFERENCES fuentes_rss(id) ON DELETE CASCADE,
  fuente_nombre TEXT,
  titulo        TEXT,
  enlace        TEXT,
  resumen       TEXT,
  publicado     TIMESTAMPTZ,
  guid          TEXT UNIQUE,          -- identificador único para no duplicar
  leida         BOOLEAN DEFAULT false,
  creado_en     TIMESTAMPTZ DEFAULT now()
);
`;

const USUARIOS = [
  { nombre: 'Carlos Méndez', usuario: 'admin', email: 'cmendez@emetra.gob.gt', avatar: 'CM', rol: 'Administrador', pass: 'emetra2026',
    permisos: ['panorama','estadisticas','credibilidad','zonas','denuncias','comentaristas','decisiones','soluciones','proyectos','amenazas','asistente','reporte','config'] },
  { nombre: 'Ana Gálvez', usuario: 'supervisor', email: 'agalvez@emetra.gob.gt', avatar: 'AG', rol: 'Supervisor', pass: 'pmt123',
    permisos: ['panorama','estadisticas','credibilidad','zonas','denuncias','comentaristas','decisiones','soluciones','proyectos','amenazas','asistente','reporte'] },
  { nombre: 'Luis Pérez', usuario: 'analista', email: 'lperez@emetra.gob.gt', avatar: 'LP', rol: 'Analista', pass: 'vial456',
    permisos: ['panorama','estadisticas','credibilidad','zonas','denuncias','comentaristas','decisiones','soluciones','proyectos','amenazas','asistente'] },
  { nombre: 'María Solís', usuario: 'lectura', email: 'msolis@emetra.gob.gt', avatar: 'MS', rol: 'Solo Lectura', pass: 'solo789',
    permisos: ['panorama','zonas','denuncias','soluciones','proyectos','reporte'] },
];

const ENTIDADES = [
  { nombre: 'Policía MT', tipo: 'Institución', handles: '@policia_mt', keywords: 'PMT, tránsito, operativo, multa', icono: 'PM', es_base: true },
  { nombre: 'Amílcar Montejo', tipo: 'Funcionario / Vocería', handles: '@amilcarmontejo', keywords: 'vocero, Montejo, vial', icono: 'AM', es_base: true },
  { nombre: 'EMETRA', tipo: 'Marca / Conjunto', handles: '@emetragt', keywords: 'EMETRA, movilidad, semáforo', icono: 'EM', es_base: true },
];

const PROYECTOS = [
  { nombre: 'Bahías Antibloqueo', aceptacion: 72, menciones: 1840, pos: 64, neg: 18, neu: 18, tendencia: [55,60,63,68,70,72] },
  { nombre: 'Motovías', aceptacion: 41, menciones: 2310, pos: 32, neg: 48, neu: 20, tendencia: [58,52,49,45,43,41] },
  { nombre: 'Educación Vial', aceptacion: 81, menciones: 960, pos: 74, neg: 9, neu: 17, tendencia: [68,71,74,77,79,81] },
];

// Crea tablas y siembra datos si la base está vacía. No borra nada existente.
export async function inicializarBase() {
  await pool.query(SCHEMA);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) {
    console.log('→ Base ya inicializada, se conserva lo existente.');
    return;
  }
  console.log('→ Sembrando datos iniciales...');
  for (const u of USUARIOS) {
    const hash = await bcrypt.hash(u.pass, 10);
    await pool.query(
      `INSERT INTO usuarios (nombre, usuario, email, avatar, rol, pass_hash, permisos) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.nombre, u.usuario, u.email, u.avatar, u.rol, hash, u.permisos]
    );
  }
  for (const e of ENTIDADES) {
    await pool.query(
      `INSERT INTO entidades (nombre, tipo, handles, keywords, icono, es_base) VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.nombre, e.tipo, e.handles, e.keywords, e.icono, e.es_base]
    );
  }
  for (const p of PROYECTOS) {
    await pool.query(
      `INSERT INTO proyectos (nombre, aceptacion, menciones, pos, neg, neu, tendencia) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.nombre, p.aceptacion, p.menciones, p.pos, p.neg, p.neu, p.tendencia]
    );
  }
  console.log('✓ Datos iniciales cargados (4 usuarios, 3 entidades, 3 proyectos).');
}

// Si se ejecuta directamente (npm run init-db), corre y cierra.
if (import.meta.url === `file://${process.argv[1]}`) {
  inicializarBase()
    .then(() => { console.log('✓ Listo.'); return pool.end(); })
    .catch((e) => { console.error('✗ Error:', e); process.exit(1); });
}
