// ─── Servidor EMETRA SENTINELA ───
// API REST: login, usuarios, entidades, proyectos y auditoría.
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import dotenv from 'dotenv';
import { pool, query } from './db.js';
import { firmarToken, requiereLogin, requierePermiso } from './auth.js';
import { inicializarBase } from './init-db.js';
import { procesarXlsx } from './procesar-xlsx.js';

// Recibe archivos en memoria (hasta 10 MB), sin guardarlos en disco.
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

dotenv.config();
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Ayudante: registra una acción en la auditoría.
async function auditar(etiqueta, texto, usuario) {
  try { await query('INSERT INTO auditoria (etiqueta, texto, usuario) VALUES ($1,$2,$3)', [etiqueta, texto, usuario]); }
  catch (e) { console.error('No se pudo auditar:', e.message); }
}

// Chequeo de salud (para saber si el servidor vive).
app.get('/api/health', (req, res) => res.json({ ok: true, servicio: 'EMETRA SENTINELA', hora: new Date() }));

// ─────────────── LOGIN ───────────────
app.post('/api/login', async (req, res) => {
  const { usuario, pass } = req.body || {};
  if (!usuario || !pass) return res.status(400).json({ error: 'Faltan usuario o contraseña.' });
  try {
    const { rows } = await query('SELECT * FROM usuarios WHERE usuario = $1', [usuario.toLowerCase()]);
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    const ok = await bcrypt.compare(pass, u.pass_hash);
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

    const token = firmarToken(u);
    await auditar('[LOGIN]', `${u.nombre} inició sesión`, u.usuario);
    res.json({
      token,
      usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, email: u.email, avatar: u.avatar, rol: u.rol, permisos: u.permisos }
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Error del servidor.' });
  }
});

// ─────────────── USUARIOS ───────────────
// Listar (cualquiera autenticado con permiso config)
app.get('/api/usuarios', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { rows } = await query('SELECT id, nombre, usuario, email, avatar, rol, permisos FROM usuarios ORDER BY creado_en');
  res.json(rows);
});

// Crear (solo config)
app.post('/api/usuarios', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { nombre, usuario, pass, rol, permisos } = req.body || {};
  if (!nombre || !usuario || !pass) return res.status(400).json({ error: 'Faltan nombre, usuario o contraseña.' });
  if (pass.length < 5) return res.status(400).json({ error: 'La contraseña debe tener al menos 5 caracteres.' });
  try {
    const existe = await query('SELECT 1 FROM usuarios WHERE usuario = $1', [usuario.toLowerCase()]);
    if (existe.rowCount) return res.status(409).json({ error: 'Ese usuario ya existe.' });
    const avatar = nombre.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const hash = await bcrypt.hash(pass, 10);
    const { rows } = await query(
      `INSERT INTO usuarios (nombre, usuario, email, avatar, rol, pass_hash, permisos)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nombre, usuario, email, avatar, rol, permisos`,
      [nombre, usuario.toLowerCase(), usuario.toLowerCase() + '@emetra.gob.gt', avatar, rol, hash, permisos || []]
    );
    await auditar('[USER]', `${req.usuario.usuario} creó usuario ${nombre}`, req.usuario.usuario);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al crear usuario.' }); }
});

// Eliminar (solo config, no a uno mismo)
app.delete('/api/usuarios/:id', requiereLogin, requierePermiso('config'), async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (u.usuario === req.usuario.usuario) return res.status(400).json({ error: 'No puedes eliminar tu propia sesión.' });
    await query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    await auditar('[USER]', `${req.usuario.usuario} eliminó usuario ${u.nombre}`, req.usuario.usuario);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al eliminar.' }); }
});

// Editar usuario: nombre, rol, permisos, y opcionalmente contraseña
app.patch('/api/usuarios/:id', requiereLogin, requierePermiso('config'), async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const nombre = (req.body.nombre ?? u.nombre).trim() || u.nombre;
    const rol = req.body.rol ?? u.rol;
    const permisos = Array.isArray(req.body.permisos) ? req.body.permisos : u.permisos;
    const avatar = nombre.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    // Si mandan una contraseña nueva (no vacía), la actualiza cifrada
    if (req.body.pass && req.body.pass.length >= 5) {
      const hash = await bcrypt.hash(req.body.pass, 10);
      await query('UPDATE usuarios SET pass_hash=$1 WHERE id=$2', [hash, req.params.id]);
    } else if (req.body.pass && req.body.pass.length > 0) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 5 caracteres.' });
    }
    const upd = await query(
      `UPDATE usuarios SET nombre=$1, rol=$2, permisos=$3, avatar=$4 WHERE id=$5
       RETURNING id, nombre, usuario, email, avatar, rol, permisos`,
      [nombre, rol, permisos, avatar, req.params.id]
    );
    await auditar('[USER]', `${req.usuario.usuario} editó usuario ${nombre}`, req.usuario.usuario);
    res.json(upd.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al editar usuario.' }); }
});

// ─────────────── ENTIDADES ───────────────
app.get('/api/entidades', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM entidades ORDER BY creado_en');
  res.json(rows);
});

app.post('/api/entidades', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { nombre, tipo, handles, keywords } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la entidad.' });
  const icono = nombre.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  const { rows } = await query(
    `INSERT INTO entidades (nombre, tipo, handles, keywords, icono, es_base)
     VALUES ($1,$2,$3,$4,$5,false) RETURNING *`,
    [nombre, tipo || 'Institución', handles || '—', keywords || '—', icono]
  );
  await auditar('[ENTITY]', `${req.usuario.usuario} agregó entidad ${nombre}`, req.usuario.usuario);
  res.status(201).json(rows[0]);
});

app.delete('/api/entidades/:id', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { rows } = await query('SELECT * FROM entidades WHERE id = $1', [req.params.id]);
  const e = rows[0];
  if (!e) return res.status(404).json({ error: 'Entidad no encontrada.' });
  await query('DELETE FROM entidades WHERE id = $1', [req.params.id]);
  await auditar('[ENTITY]', `${req.usuario.usuario} eliminó entidad ${e.nombre}${e.es_base ? ' (BASE)' : ''}`, req.usuario.usuario);
  res.json({ ok: true });
});

// Editar una entidad existente
app.patch('/api/entidades/:id', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { rows } = await query('SELECT * FROM entidades WHERE id = $1', [req.params.id]);
  const e = rows[0];
  if (!e) return res.status(404).json({ error: 'Entidad no encontrada.' });
  const nombre = (req.body.nombre ?? e.nombre).trim() || e.nombre;
  const tipo = req.body.tipo ?? e.tipo;
  const handles = req.body.handles ?? e.handles;
  const keywords = req.body.keywords ?? e.keywords;
  const icono = nombre.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  const upd = await query(
    `UPDATE entidades SET nombre=$1, tipo=$2, handles=$3, keywords=$4, icono=$5 WHERE id=$6 RETURNING *`,
    [nombre, tipo, handles, keywords, icono, req.params.id]
  );
  await auditar('[ENTITY]', `${req.usuario.usuario} editó entidad ${nombre}`, req.usuario.usuario);
  res.json(upd.rows[0]);
});

// ─────────────── PROYECTOS ───────────────
app.get('/api/proyectos', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM proyectos ORDER BY creado_en');
  res.json(rows);
});

app.post('/api/proyectos', requiereLogin, requierePermiso('proyectos'), async (req, res) => {
  let { nombre, aceptacion, menciones } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del proyecto.' });
  aceptacion = Number.isInteger(aceptacion) ? Math.max(0, Math.min(100, aceptacion)) : 50;
  menciones = Number.isInteger(menciones) ? Math.max(0, menciones) : 100;
  const pos = Math.round(aceptacion * 0.85);
  const neg = Math.round((100 - aceptacion) * 0.65);
  const neu = Math.max(0, 100 - pos - neg);
  const tendencia = [];
  for (let i = 5; i >= 0; i--) tendencia.push(Math.max(0, Math.min(100, aceptacion - i * 3)));
  tendencia[5] = aceptacion;
  const { rows } = await query(
    `INSERT INTO proyectos (nombre, aceptacion, menciones, pos, neg, neu, tendencia)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [nombre, aceptacion, menciones, pos, neg, neu, tendencia]
  );
  await auditar('[PROJECT]', `${req.usuario.usuario} agregó proyecto ${nombre}`, req.usuario.usuario);
  res.status(201).json(rows[0]);
});

app.delete('/api/proyectos/:id', requiereLogin, requierePermiso('proyectos'), async (req, res) => {
  const { rows } = await query('SELECT * FROM proyectos WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Proyecto no encontrado.' });
  await query('DELETE FROM proyectos WHERE id = $1', [req.params.id]);
  await auditar('[PROJECT]', `${req.usuario.usuario} eliminó proyecto ${p.nombre}`, req.usuario.usuario);
  res.json({ ok: true });
});

// ─────────────── SENTIMIENTO MENSUAL (histórico por entidad) ───────────────
// Trae todo el histórico, agrupado por entidad
app.get('/api/sentimiento-mensual', requiereLogin, async (req, res) => {
  const { rows } = await query(
    `SELECT sm.*, e.nombre AS entidad_nombre, e.icono AS entidad_icono
     FROM sentimiento_mensual sm
     JOIN entidades e ON e.id = sm.entidad_id
     ORDER BY sm.anio, sm.mes`
  );
  res.json(rows);
});

// Guardar (o actualizar) un mes para una entidad
app.post('/api/sentimiento-mensual', requiereLogin, requierePermiso('decisiones'), async (req, res) => {
  let { entidad_id, anio, mes, positivo, negativo, neutro } = req.body || {};
  entidad_id = parseInt(entidad_id); anio = parseInt(anio); mes = parseInt(mes);
  positivo = parseInt(positivo); negativo = parseInt(negativo); neutro = parseInt(neutro);
  if (!entidad_id || !anio || !mes) return res.status(400).json({ error: 'Faltan entidad, año o mes.' });
  if (mes < 1 || mes > 12) return res.status(400).json({ error: 'Mes inválido (1-12).' });
  [positivo, negativo, neutro] = [positivo, negativo, neutro].map(v => isNaN(v) ? 0 : Math.max(0, Math.min(100, v)));
  try {
    // UPSERT: si ya existe ese mes/entidad, lo actualiza
    const { rows } = await query(
      `INSERT INTO sentimiento_mensual (entidad_id, anio, mes, positivo, negativo, neutro)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (entidad_id, anio, mes)
       DO UPDATE SET positivo=$4, negativo=$5, neutro=$6
       RETURNING *`,
      [entidad_id, anio, mes, positivo, negativo, neutro]
    );
    await auditar('[SENTIMIENTO]', `${req.usuario.usuario} registró sentimiento ${mes}/${anio}`, req.usuario.usuario);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al guardar.' }); }
});

// Eliminar un registro mensual
app.delete('/api/sentimiento-mensual/:id', requiereLogin, requierePermiso('decisiones'), async (req, res) => {
  await query('DELETE FROM sentimiento_mensual WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─────────────── CARGA DE DATOS (.xlsx de ExportComments) ───────────────
// Subir un archivo. Requiere permiso de analista o superior (usamos 'decisiones').
app.post('/api/cargar', requiereLogin, requierePermiso('decisiones'), subida.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  try {
    const resumen = await procesarXlsx(req.file.buffer, {
      archivo: req.file.originalname,
      subidoPor: req.usuario.usuario,
    });
    await auditar('[CARGA]', `${req.usuario.usuario} subió ${resumen.archivo}: ${resumen.total} comentarios (${resumen.dudosos} por revisar)`, req.usuario.usuario);
    res.json(resumen);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || 'No se pudo procesar el archivo.' });
  }
});

// Histórico de cargas (para ver tendencias en el tiempo)
app.get('/api/cargas', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM cargas ORDER BY creado_en DESC');
  res.json(rows);
});

// Resumen acumulado de TODAS las menciones (lo que alimenta el panel)
app.get('/api/resumen', requiereLogin, async (req, res) => {
  const sent = await query(`SELECT sentimiento, COUNT(*)::int AS n FROM menciones GROUP BY sentimiento`);
  const zonas = await query(`SELECT zona, COUNT(*)::int AS n FROM menciones WHERE zona IS NOT NULL GROUP BY zona ORDER BY n DESC LIMIT 15`);
  const dudosos = await query(`SELECT COUNT(*)::int AS n FROM menciones WHERE confianza < 0.6 AND revisado = false`);
  const total = await query(`SELECT COUNT(*)::int AS n FROM menciones`);
  res.json({
    total: total.rows[0].n,
    sentimiento: sent.rows,
    zonas: zonas.rows,
    porRevisar: dudosos.rows[0].n,
  });
});

// Lista de comentarios dudosos (para que una persona los ajuste)
app.get('/api/dudosos', requiereLogin, requierePermiso('decisiones'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, autor, texto, sentimiento, confianza, zona, fecha
     FROM menciones WHERE confianza < 0.6 AND revisado = false
     ORDER BY creado_en DESC LIMIT 100`
  );
  res.json(rows);
});

// Corregir el sentimiento de un comentario (revisión humana)
app.patch('/api/menciones/:id', requiereLogin, requierePermiso('decisiones'), async (req, res) => {
  const { sentimiento } = req.body || {};
  if (!['positivo', 'negativo', 'neutro'].includes(sentimiento)) {
    return res.status(400).json({ error: 'Sentimiento inválido.' });
  }
  await query(
    `UPDATE menciones SET sentimiento=$1, confianza=1, revisado=true WHERE id=$2`,
    [sentimiento, req.params.id]
  );
  await auditar('[REVISION]', `${req.usuario.usuario} ajustó un comentario a ${sentimiento}`, req.usuario.usuario);
  res.json({ ok: true });
});

// ─────────────── AUDITORÍA ───────────────
app.get('/api/auditoria', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { rows } = await query('SELECT etiqueta, texto, usuario, creado_en FROM auditoria ORDER BY creado_en DESC LIMIT 50');
  res.json(rows);
});

const PORT = process.env.PORT || 4000;

// Al arrancar: asegura que las tablas existan y los datos base estén cargados.
inicializarBase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✓ EMETRA SENTINELA backend corriendo en el puerto ${PORT}`);
      console.log(`  Prueba de salud: /api/health`);
    });
  })
  .catch((e) => {
    console.error('✗ No se pudo inicializar la base de datos:', e);
    process.exit(1);
  });
