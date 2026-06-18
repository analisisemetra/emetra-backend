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
import { procesarMetricas } from './procesar-metricas.js';
import { leerTodasLasAlertas } from './leer-alertas.js';
import { analizarAmenazas } from './amenazas.js';

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

// ─────────────── ACTORES (medios, políticos, empresarios) ───────────────
app.get('/api/actores', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM actores ORDER BY creado_en DESC');
  res.json(rows);
});

app.post('/api/actores', requiereLogin, requierePermiso('amenazas'), async (req, res) => {
  const { nombre, tipo, postura, redes, notas } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del actor.' });
  const tiposOk = ['medio', 'politico', 'empresario'];
  const posturasOk = ['favor', 'contra', 'neutral'];
  const t = tiposOk.includes(tipo) ? tipo : 'medio';
  const p = posturasOk.includes(postura) ? postura : 'neutral';
  const { rows } = await query(
    `INSERT INTO actores (nombre, tipo, postura, redes, notas) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [nombre.trim(), t, p, redes || '', notas || '']
  );
  await auditar('[ACTOR]', `${req.usuario.usuario} agregó ${t} ${nombre}`, req.usuario.usuario);
  res.status(201).json(rows[0]);
});

app.patch('/api/actores/:id', requiereLogin, requierePermiso('amenazas'), async (req, res) => {
  const { rows } = await query('SELECT * FROM actores WHERE id = $1', [req.params.id]);
  const a = rows[0];
  if (!a) return res.status(404).json({ error: 'Actor no encontrado.' });
  const nombre = (req.body.nombre ?? a.nombre).trim() || a.nombre;
  const tipo = ['medio','politico','empresario'].includes(req.body.tipo) ? req.body.tipo : a.tipo;
  const postura = ['favor','contra','neutral'].includes(req.body.postura) ? req.body.postura : a.postura;
  const redes = req.body.redes ?? a.redes;
  const notas = req.body.notas ?? a.notas;
  const upd = await query(
    `UPDATE actores SET nombre=$1, tipo=$2, postura=$3, redes=$4, notas=$5 WHERE id=$6 RETURNING *`,
    [nombre, tipo, postura, redes, notas, req.params.id]
  );
  await auditar('[ACTOR]', `${req.usuario.usuario} editó ${nombre}`, req.usuario.usuario);
  res.json(upd.rows[0]);
});

app.delete('/api/actores/:id', requiereLogin, requierePermiso('amenazas'), async (req, res) => {
  const { rows } = await query('SELECT * FROM actores WHERE id = $1', [req.params.id]);
  const a = rows[0];
  if (!a) return res.status(404).json({ error: 'Actor no encontrado.' });
  await query('DELETE FROM actores WHERE id = $1', [req.params.id]);
  await auditar('[ACTOR]', `${req.usuario.usuario} eliminó ${a.nombre}`, req.usuario.usuario);
  res.json({ ok: true });
});

// ─────────────── NOTICIAS (alimentan el mapa de poder) ───────────────
// Listar noticias capturadas
app.get('/api/noticias', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM noticias ORDER BY creado_en DESC LIMIT 200');
  res.json(rows);
});
// Agregar una noticia → crea o actualiza el actor que la publica
app.post('/api/noticias', requiereLogin, requierePermiso('amenazas'), async (req, res) => {
  const { titulo, actor, tipo, postura, enlace } = req.body || {};
  if (!actor || !titulo) return res.status(400).json({ error: 'Falta el actor o el texto de la noticia.' });
  const tipoVal = ['medio', 'politico', 'civil', 'ficticio'].includes(tipo) ? tipo : 'medio';
  const postVal = ['favor', 'contra', 'neutral'].includes(postura) ? postura : 'neutral';
  // guarda la noticia
  const { rows } = await query(
    `INSERT INTO noticias (titulo, actor, tipo, postura, enlace) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [titulo.trim(), actor.trim(), tipoVal, postVal, (enlace || '').trim()]
  );
  // crea o actualiza el actor con el tipo real (medio/politico/civil/ficticio)
  const tipoActor = tipoVal;
  const existe = await query('SELECT id FROM actores WHERE lower(nombre) = lower($1) LIMIT 1', [actor.trim()]);
  if (existe.rows.length > 0) {
    // actualiza su postura a la más reciente
    await query('UPDATE actores SET postura=$1, tipo=$2 WHERE id=$3', [postVal, tipoActor, existe.rows[0].id]);
  } else {
    await query('INSERT INTO actores (nombre, tipo, postura, notas) VALUES ($1,$2,$3,$4)',
      [actor.trim(), tipoActor, postVal, 'Creado desde captura de noticias']);
  }
  await auditar('[NOTICIA]', `${req.usuario.usuario} agregó noticia de ${actor}`, req.usuario.usuario);
  res.status(201).json(rows[0]);
});
// Eliminar una noticia
app.delete('/api/noticias/:id', requiereLogin, requierePermiso('amenazas'), async (req, res) => {
  await query('DELETE FROM noticias WHERE id = $1', [req.params.id]);
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

// ─────────────── MÉTRICAS (plantilla de Excel) ───────────────
// Subir la plantilla de métricas
app.post('/api/metricas', requiereLogin, requierePermiso('decisiones'), subida.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  try {
    const resumen = await procesarMetricas(req.file.buffer);
    await auditar('[METRICAS]', `${req.usuario.usuario} subió métricas: ${resumen.publicaciones} pubs, ${resumen.credibilidad} cred, ${resumen.zonas} zonas`, req.usuario.usuario);
    res.json(resumen);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || 'No se pudo procesar la plantilla.' });
  }
});

// Datos para PANORAMA: combina comentarios (sentimiento) + publicaciones (alcance)
app.get('/api/panorama', requiereLogin, async (req, res) => {
  const sent = await query(`SELECT sentimiento, COUNT(*)::int AS n FROM menciones GROUP BY sentimiento`);
  const totalCom = await query(`SELECT COUNT(*)::int AS n FROM menciones`);
  const pubs = await query(`SELECT COUNT(*)::int AS posts, COALESCE(SUM(alcance),0)::bigint AS alcance, COALESCE(SUM(plays),0)::bigint AS plays, COALESCE(SUM(likes+comentarios+compartidos),0)::bigint AS interacciones FROM publicaciones`);
  const porTema = await query(`SELECT tema, COUNT(*)::int AS posts, COALESCE(SUM(alcance),0)::bigint AS alcance FROM publicaciones WHERE tema <> '' GROUP BY tema ORDER BY alcance DESC`);
  const porRed = await query(`SELECT red, COUNT(*)::int AS posts, COALESCE(SUM(plays),0)::bigint AS plays, COALESCE(SUM(alcance),0)::bigint AS alcance FROM publicaciones WHERE red <> '' GROUP BY red ORDER BY alcance DESC`);
  // frases recurrentes en comentarios negativos (palabras más comunes)
  const negs = await query(`SELECT texto FROM menciones WHERE sentimiento='negativo' AND texto IS NOT NULL LIMIT 1000`);
  const frases = calcularFrases(negs.rows.map(r => r.texto));
  // sentimiento en porcentajes
  const s = { positivo: 0, negativo: 0, neutro: 0 };
  sent.rows.forEach(r => { s[r.sentimiento] = r.n; });
  const tot = s.positivo + s.negativo + s.neutro || 1;
  res.json({
    totalComentarios: totalCom.rows[0].n,
    totalPosts: pubs.rows[0].posts,
    alcanceTotal: Number(pubs.rows[0].alcance),
    playsTotal: Number(pubs.rows[0].plays),
    interaccionesTotal: Number(pubs.rows[0].interacciones),
    sentimiento: {
      positivo: Math.round(s.positivo / tot * 100),
      negativo: Math.round(s.negativo / tot * 100),
      neutro: Math.round(s.neutro / tot * 100),
      conteo: s,
    },
    porTema: porTema.rows.map(r => ({ tema: r.tema, posts: r.posts, alcance: Number(r.alcance) })),
    porRed: porRed.rows.map(r => ({ red: r.red, posts: r.posts, plays: Number(r.plays), alcance: Number(r.alcance) })),
    frases,
  });
});

// Calcula frases/palabras recurrentes (bigramas) en una lista de textos
function calcularFrases(textos) {
  const stop = new Set(['que','de','la','el','los','las','un','una','y','o','a','en','con','por','para','se','su','sus','lo','le','les','del','al','es','son','no','si','ya','me','mi','te','tu','como','mas','más','pero','muy','este','esta','eso','esa','hay','han','ha','sus','está','están','solo','sólo','ni','yo','ellos','nos','porque','cuando','donde','aqui','aquí','asi','así']);
  const conteo = new Map();
  for (const t of textos) {
    const palabras = String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9ñ ]/g,' ').split(/\s+/).filter(w => w.length > 3 && !stop.has(w));
    // bigramas
    for (let i = 0; i < palabras.length - 1; i++) {
      const bi = palabras[i] + ' ' + palabras[i+1];
      conteo.set(bi, (conteo.get(bi) || 0) + 1);
    }
    // palabras sueltas relevantes
    for (const w of palabras) conteo.set(w, (conteo.get(w) || 0) + 1);
  }
  return [...conteo.entries()]
    .filter(([k, v]) => v >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([frase, n]) => ({ frase, n }));
}


// Datos de CREDIBILIDAD
app.get('/api/credibilidad', requiereLogin, async (req, res) => {
  // Héctor Flores (personaje principal) siempre primero, luego por puntaje
  const { rows } = await query(`
    SELECT * FROM credibilidad
    ORDER BY (CASE WHEN lower(entidad) LIKE '%héctor flores%' OR lower(entidad) LIKE '%hector flores%' THEN 0 ELSE 1 END),
             puntaje DESC`);
  res.json(rows);
});

// Registrar credibilidad de una semana (actualiza el snapshot Y guarda en histórico)
app.post('/api/credibilidad', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { entidad, semana, puntaje, respuesta, transparencia, consistencia, cercania } = req.body || {};
  if (!entidad || !semana) return res.status(400).json({ error: 'Falta entidad o semana.' });
  const n = (v) => { const x = parseInt(v); return isNaN(x) ? 0 : Math.max(0, Math.min(100, x)); };
  const vals = [entidad.trim(), semana.trim(), n(puntaje), n(respuesta), n(transparencia), n(consistencia), n(cercania)];
  // histórico
  await query(`
    INSERT INTO credibilidad_historico (entidad, semana, puntaje, respuesta, transparencia, consistencia, cercania)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (entidad, semana) DO UPDATE SET puntaje=$3, respuesta=$4, transparencia=$5, consistencia=$6, cercania=$7`, vals);
  // snapshot actual (la credibilidad "vigente" = el último registro)
  await query(`
    INSERT INTO credibilidad (entidad, puntaje, respuesta, transparencia, consistencia, cercania)
    VALUES ($1,$3,$4,$5,$6,$7)
    ON CONFLICT (entidad) DO UPDATE SET puntaje=$3, respuesta=$4, transparencia=$5, consistencia=$6, cercania=$7`,
    [vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6]]);
  await auditar('[CREDIBILIDAD]', `${req.usuario.usuario} registró ${entidad} en ${semana}`, req.usuario.usuario);
  res.status(201).json({ ok: true });
});

// Evolución semanal de credibilidad (todas las entidades)
app.get('/api/credibilidad-historico', requiereLogin, async (req, res) => {
  const { rows } = await query(`SELECT entidad, semana, puntaje FROM credibilidad_historico ORDER BY semana, entidad`);
  // organiza: { semanas:[...], entidades:{ nombre:[puntajes...] } }
  const semanas = [...new Set(rows.map(r => r.semana))].sort();
  const entidades = {};
  for (const r of rows) {
    if (!entidades[r.entidad]) entidades[r.entidad] = {};
    entidades[r.entidad][r.semana] = r.puntaje;
  }
  // alinea cada entidad con todas las semanas (null donde no haya dato)
  const series = {};
  for (const ent of Object.keys(entidades)) {
    series[ent] = semanas.map(s => entidades[ent][s] ?? null);
  }
  res.json({ semanas, series });
});

// Ficha del personaje principal (Héctor Flores): su estado resumido para el Pulso
app.get('/api/ficha-principal', requiereLogin, async (req, res) => {
  const nombre = 'Héctor Flores';
  // credibilidad
  const cred = await query(`SELECT * FROM credibilidad WHERE lower(entidad) LIKE '%héctor flores%' OR lower(entidad) LIKE '%hector flores%' LIMIT 1`);
  // menciones en comentarios (texto que lo nombra)
  const menc = await query(`
    SELECT COUNT(*)::int AS total,
           SUM(CASE WHEN sentimiento='positivo' THEN 1 ELSE 0 END)::int AS pos,
           SUM(CASE WHEN sentimiento='negativo' THEN 1 ELSE 0 END)::int AS neg,
           SUM(CASE WHEN sentimiento='neutro' THEN 1 ELSE 0 END)::int AS neu
    FROM menciones
    WHERE lower(texto) LIKE '%héctor flores%' OR lower(texto) LIKE '%hector flores%' OR lower(texto) LIKE '%gerente%emetra%'`);
  // menciones en medios (alertas)
  const alertas = await query(`
    SELECT COUNT(*)::int AS total FROM menciones_alertas
    WHERE lower(titulo) LIKE '%héctor flores%' OR lower(titulo) LIKE '%hector flores%' OR lower(resumen) LIKE '%héctor flores%' OR lower(resumen) LIKE '%hector flores%'`);
  // últimas menciones en medios sobre él
  const ultimas = await query(`
    SELECT titulo, fuente_nombre, enlace, publicado FROM menciones_alertas
    WHERE lower(titulo) LIKE '%héctor flores%' OR lower(titulo) LIKE '%hector flores%' OR lower(resumen) LIKE '%héctor flores%' OR lower(resumen) LIKE '%hector flores%'
    ORDER BY publicado DESC NULLS LAST LIMIT 5`);
  const m = menc.rows[0];
  const totalCom = m.total || 0;
  res.json({
    nombre,
    credibilidad: cred.rows[0] || null,
    menciones: {
      total: totalCom,
      positivos: m.pos || 0,
      negativos: m.neg || 0,
      neutros: m.neu || 0,
      pctPos: totalCom ? Math.round((m.pos||0)/totalCom*100) : 0,
      pctNeg: totalCom ? Math.round((m.neg||0)/totalCom*100) : 0,
    },
    menciones_medios: alertas.rows[0].total || 0,
    ultimas_medios: ultimas.rows,
  });
});

// Datos de ZONAS (de la plantilla, no de comentarios)
app.get('/api/zonas', requiereLogin, async (req, res) => {
  // Zonas calculadas automáticamente de los comentarios (mención + sentimiento)
  const { rows } = await query(`
    SELECT zona,
           COUNT(*)::int AS menciones,
           SUM(CASE WHEN sentimiento='negativo' THEN 1 ELSE 0 END)::int AS negativos,
           SUM(CASE WHEN sentimiento='positivo' THEN 1 ELSE 0 END)::int AS positivos
    FROM menciones
    WHERE zona IS NOT NULL AND zona <> ''
    GROUP BY zona
    ORDER BY menciones DESC`);
  // nota = tono dominante
  const zonas = rows.map(z => {
    let nota = 'Mixto';
    if (z.negativos > z.positivos * 1.5) nota = 'Predominio de quejas';
    else if (z.positivos > z.negativos) nota = 'Predominio de apoyo';
    return { zona: z.zona, menciones: z.menciones, negativos: z.negativos, positivos: z.positivos, nota };
  });
  res.json(zonas);
});

// Datos para la pestaña ESTADÍSTICAS (todas las gráficas)
app.get('/api/estadisticas', requiereLogin, async (req, res) => {
  // Alcance vs recepción por tema (de publicaciones)
  const porTema = await query(`SELECT tema, COUNT(*)::int AS posts, COALESCE(SUM(alcance),0)::bigint AS alcance, COALESCE(SUM(likes+comentarios+compartidos),0)::bigint AS interacciones FROM publicaciones WHERE tema <> '' GROUP BY tema ORDER BY alcance DESC`);
  // Radar de crisis: menciones por día (de los comentarios reales, por fecha)
  const crisis = await query(`SELECT to_char(fecha::date,'YYYY-MM-DD') AS fecha, COUNT(*)::int AS menciones FROM menciones WHERE fecha IS NOT NULL GROUP BY fecha::date ORDER BY fecha::date`);
  // Plataformas con más alcance (de publicaciones, ranking por alcance)
  const plataformas = await query(`SELECT red, COALESCE(SUM(alcance),0)::bigint AS alcance, COALESCE(SUM(plays),0)::bigint AS plays, COUNT(*)::int AS posts FROM publicaciones WHERE red <> '' GROUP BY red ORDER BY alcance DESC`);
  // Nube de dolores: agrupa los cientos de dolores específicos en categorías amplias
  const doloresRaw = await query(`SELECT dolor, COUNT(*)::int AS n FROM menciones WHERE dolor IS NOT NULL AND dolor <> '' GROUP BY dolor`);
  const dolores = agruparDolores(doloresRaw.rows);
  // Sentimiento por tema (de los comentarios, si tuvieran tema; si no, de la tabla sentimiento_tema de la plantilla)
  const sentTemaPlantilla = await query(`SELECT tema, positivos, negativos, neutros FROM sentimiento_tema ORDER BY (positivos+negativos+neutros) DESC`);
  // Positivos vs negativos por semana (de la plantilla)
  const semanal = await query(`SELECT semana, positivos, negativos FROM sentimiento_semanal ORDER BY semana`);
  res.json({
    porTema: porTema.rows.map(r => ({ tema: r.tema, posts: r.posts, alcance: Number(r.alcance), interacciones: Number(r.interacciones) })),
    crisis: crisis.rows.map(r => ({ fecha: r.fecha, menciones: r.menciones })),
    plataformas: plataformas.rows.map(r => ({ red: r.red, alcance: Number(r.alcance), plays: Number(r.plays), posts: r.posts })),
    dolores,
    sentTema: sentTemaPlantilla.rows,
    semanal: semanal.rows,
  });
});

// Agrupa dolores específicos en categorías amplias por palabras clave.
// Devuelve el top 15 con su categoría canónica.
function agruparDolores(filas) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // categoría canónica → palabras que la activan (orden importa: la primera que coincide gana)
  const CATEGORIAS = [
    ['Motos en banqueta', ['banqueta', 'acera', 'moto en la', 'motos en la', 'motociclistas en']],
    ['Multas injustas / abusivas', ['multa injusta', 'multas injusta', 'multa abusiva', 'multas abusiva', 'multas excesiva', 'multa excesiva', 'extorsion', 'solo multa', 'solo cobr', 'recaudacion', 'multas falsas', 'multa falsa', 'multas fantasma']],
    ['Corrupción / mordida', ['corrupc', 'corrupto', 'mordida', 'coima', 'soborno', 'malversacion', 'enriquecimiento']],
    ['Falta de operativos', ['falta de operativo', 'operativos insuficiente', 'no hacen nada', 'no hay operativo', 'inaccion', 'falta de accion', 'no estan', 'donde estan']],
    ['Cepos / inmovilizadores', ['cepo', 'inmovilizador', 'garra', 'arana']],
    ['Congestión / tráfico', ['trafico', 'congestion', 'tranque', 'embotellamiento', 'no avanza', 'caos vial', 'caos vehicular']],
    ['Transporte público', ['transporte publico', 'transmetro', 'transurbano', 'bus rojo', 'buses rojo', 'camioneta', 'pilotos de bus', 'piloto de bus']],
    ['Taxis / transporte pirata', ['taxi pirata', 'taxis pirata', 'pirata']],
    ['Licencias', ['licencia']],
    ['Educación vial', ['educacion vial', 'cultura vial']],
    ['Semáforos / señalización', ['semaforo', 'senalizacion', 'senales', 'senal vial']],
    ['Vehículos / vendedores que apartan parqueo', ['apartan parqueo', 'aparta parqueo', 'apartaparqueo', 'aparta-parqueo', 'estacionamiento irregular', 'mal parqueo', 'parqueo informal', 'ocupan parqueo']],
    ['Ventas / obstáculos en vía pública', ['venta informal', 'ventas informal', 'venta de licencia', 'vendedores', 'obstaculo', 'obstaculos', 'via publica ocupada', 'apartadores']],
    ['Doble moral / vehículos oficiales', ['doble moral', 'vehiculo oficial', 'vehiculos oficiale', 'doble estandar', 'ellos si pueden', 'favoritismo', 'arrogancia']],
    ['Infraestructura vial', ['infraestructura', 'baches', 'calles en mal estado', 'mal estado de calle', 'carreteras en mal', 'sin reparacion', 'mantenimiento vial']],
    ['Accidentes / seguridad vial', ['accidente', 'choque', 'atropell', 'muerte', 'muertos', 'conductores ebrios', 'alcohol al volante', 'ebrio']],
  ];
  const acum = {};
  let otros = 0;
  for (const f of filas) {
    const t = norm(f.dolor);
    let cat = null;
    for (const [nombre, claves] of CATEGORIAS) {
      if (claves.some(k => t.includes(norm(k)))) { cat = nombre; break; }
    }
    if (cat) acum[cat] = (acum[cat] || 0) + f.n;
    else otros += f.n;
  }
  const lista = Object.entries(acum).map(([dolor, n]) => ({ dolor, n }));
  lista.sort((a, b) => b.n - a.n);
  const top = lista.slice(0, 15);
  // agrega "Otros" solo si es relevante y no domina
  if (otros > 0 && top.length > 0) top.push({ dolor: 'Otros', n: otros });
  return top;
}

// Comentarios de una categoría de dolor (para el clic en la burbuja)
app.get('/api/dolor-comentarios', requiereLogin, async (req, res) => {
  const cat = String(req.query.cat || '').trim();
  if (!cat) return res.json([]);
  // mismo mapa de categorías → palabras clave (coincide con agruparDolores)
  const MAPA = {
    'Motos en banqueta': ['banqueta', 'acera', 'motociclistas en'],
    'Multas injustas / abusivas': ['multa injusta', 'multas injusta', 'multa abusiva', 'multas abusiva', 'excesiva', 'extorsion', 'solo multa', 'recaudacion', 'fantasma', 'falsa'],
    'Corrupción / mordida': ['corrupc', 'corrupto', 'mordida', 'coima', 'soborno', 'malversacion', 'enriquecimiento'],
    'Falta de operativos': ['falta de operativo', 'insuficiente', 'no hacen nada', 'inaccion', 'no estan', 'donde estan'],
    'Cepos / inmovilizadores': ['cepo', 'inmovilizador', 'garra', 'arana'],
    'Congestión / tráfico': ['trafico', 'congestion', 'tranque', 'embotellamiento', 'caos'],
    'Transporte público': ['transporte publico', 'transmetro', 'transurbano', 'bus rojo', 'camioneta', 'piloto'],
    'Taxis / transporte pirata': ['taxi pirata', 'pirata'],
    'Licencias': ['licencia'],
    'Educación vial': ['educacion vial', 'cultura vial'],
    'Semáforos / señalización': ['semaforo', 'senalizacion', 'senal'],
    'Vehículos / vendedores que apartan parqueo': ['apartan parqueo', 'aparta parqueo', 'apartaparqueo', 'estacionamiento irregular', 'mal parqueo', 'parqueo informal', 'ocupan parqueo'],
    'Ventas / obstáculos en vía pública': ['venta informal', 'venta de licencia', 'vendedores', 'obstaculo', 'apartadores'],
    'Doble moral / vehículos oficiales': ['doble moral', 'vehiculo oficial', 'doble estandar', 'favoritismo', 'arrogancia'],
    'Infraestructura vial': ['infraestructura', 'baches', 'mal estado', 'carreteras', 'mantenimiento'],
    'Accidentes / seguridad vial': ['accidente', 'choque', 'atropell', 'muerte', 'ebrio', 'alcohol'],
  };
  const claves = MAPA[cat];
  if (!claves) return res.json([]);
  const params = claves.map(k => `%${k}%`);
  let rows;
  try {
    const conds = claves.map((_, i) => `unaccent(lower(dolor)) LIKE unaccent($${i + 1})`).join(' OR ');
    const r = await query(`SELECT texto, autor, red, sentimiento, fecha, permalink FROM menciones WHERE dolor IS NOT NULL AND (${conds}) ORDER BY fecha DESC NULLS LAST LIMIT 30`, params);
    rows = r.rows;
  } catch (e) {
    // si unaccent no está disponible, cae a lower simple
    const conds2 = claves.map((_, i) => `lower(dolor) LIKE $${i + 1}`).join(' OR ');
    const r = await query(`SELECT texto, autor, red, sentimiento, fecha, permalink FROM menciones WHERE dolor IS NOT NULL AND (${conds2}) ORDER BY fecha DESC NULLS LAST LIMIT 30`, params);
    rows = r.rows;
  }
  res.json(rows);
});

// Sentimiento por actor (de la tabla actores, datos reales)
app.get('/api/sentimiento-actores', requiereLogin, async (req, res) => {
  // Cuenta actores por postura, agrupados — esto refleja tus actores reales
  const { rows } = await query(`SELECT nombre, postura FROM actores ORDER BY nombre`);
  res.json(rows);
});

// Datos forenses: reincidentes y cuentas de X con datos de perfil
app.get('/api/forense', requiereLogin, async (req, res) => {
  // Reincidentes: personas (profile_id) que aparecen en varias menciones negativas
  const reincidentes = await query(`
    SELECT autor, username, profile_id, red, COUNT(*)::int AS apariciones,
           SUM(CASE WHEN sentimiento='negativo' THEN 1 ELSE 0 END)::int AS negativos,
           MAX(followers) AS followers
    FROM menciones
    WHERE profile_id IS NOT NULL AND profile_id <> ''
    GROUP BY autor, username, profile_id, red
    HAVING COUNT(*) > 1
    ORDER BY negativos DESC, apariciones DESC
    LIMIT 50`);
  // Cuentas de X con más seguidores que nos mencionan (influyentes)
  const influyentes = await query(`
    SELECT autor, username, followers, ubicacion, verificado, sentimiento, texto
    FROM menciones
    WHERE red='X' AND followers IS NOT NULL
    ORDER BY followers DESC LIMIT 20`);
  res.json({
    reincidentes: reincidentes.rows,
    influyentes: influyentes.rows,
  });
});

// Análisis de amenazas: hostilidad y patrones de coordinación (de comentarios reales)
app.get('/api/amenazas', requiereLogin, async (req, res) => {
  try {
    const r = await analizarAmenazas();
    res.json(r);
  } catch (e) { console.error('Amenazas:', e); res.status(500).json({ error: 'Error al analizar amenazas.' }); }
});

// Denuncias ciudadanas — generadas automáticamente de los comentarios
// (comentarios negativos que mencionan una zona o dirección concreta)
app.get('/api/denuncias', requiereLogin, async (req, res) => {
  const { rows } = await query(`
    SELECT id, fecha, zona, direccion, dolor AS tipo, senalado, texto AS descripcion, sentimiento, autor, red, permalink
    FROM menciones
    WHERE sentimiento='negativo'
      AND (zona IS NOT NULL OR direccion IS NOT NULL OR dolor IS NOT NULL)
    ORDER BY fecha DESC NULLS LAST
    LIMIT 200`);
  res.json(rows.map(r => ({
    id: r.id,
    fecha: r.fecha,
    zona: r.zona || (r.direccion ? '—' : 'Sin zona'),
    direccion: r.direccion,
    tipo: r.tipo || 'Queja general',
    senalado: r.senalado,
    descripcion: r.descripcion,
    autor: r.autor,
    red: r.red,
    enlace: r.permalink,
    estado: 'Pendiente',
  })));
});

// Proyectos con métricas (de la plantilla)
app.get('/api/proyectos-metricas', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM proyectos_metricas ORDER BY aceptacion DESC');
  res.json(rows);
});

// ─────────────── ALERTAS (menciones vía Google Alerts RSS) ───────────────
// Listar las fuentes RSS registradas
app.get('/api/fuentes', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM fuentes_rss ORDER BY creado_en');
  res.json(rows);
});
// Agregar una fuente RSS
app.post('/api/fuentes', requiereLogin, requierePermiso('config'), async (req, res) => {
  const { nombre, url } = req.body || {};
  if (!nombre || !url) return res.status(400).json({ error: 'Falta nombre o URL.' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'La URL debe empezar con http(s)://' });
  const { rows } = await query('INSERT INTO fuentes_rss (nombre, url) VALUES ($1,$2) RETURNING *', [nombre.trim(), url.trim()]);
  await auditar('[ALERTA]', `${req.usuario.usuario} agregó fuente ${nombre}`, req.usuario.usuario);
  res.status(201).json(rows[0]);
});
// Eliminar una fuente
app.delete('/api/fuentes/:id', requiereLogin, requierePermiso('config'), async (req, res) => {
  await query('DELETE FROM fuentes_rss WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});
// Refrescar: lee todos los feeds ahora mismo
app.post('/api/alertas/refrescar', requiereLogin, async (req, res) => {
  try {
    const r = await leerTodasLasAlertas();
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error al leer alertas.' }); }
});
// Listar menciones detectadas (más recientes primero)
app.get('/api/alertas', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT * FROM menciones_alertas ORDER BY publicado DESC NULLS LAST, creado_en DESC LIMIT 100');
  res.json(rows);
});
// Cuántas no leídas
app.get('/api/alertas/nuevas', requiereLogin, async (req, res) => {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM menciones_alertas WHERE leida = false');
  res.json({ nuevas: rows[0].n });
});
// Marcar todas como leídas
app.post('/api/alertas/marcar-leidas', requiereLogin, async (req, res) => {
  await query('UPDATE menciones_alertas SET leida = true WHERE leida = false');
  res.json({ ok: true });
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
    // Revisión automática de alertas cada hora (si el backend está despierto)
    setInterval(async () => {
      try {
        const r = await leerTodasLasAlertas();
        if (r.nuevas > 0) console.log(`[ALERTAS] ${r.nuevas} menciones nuevas de ${r.fuentes} fuentes`);
      } catch (e) { console.error('[ALERTAS] Error en revisión automática:', e.message); }
    }, 60 * 60 * 1000); // cada 60 minutos
  })
  .catch((e) => {
    console.error('✗ No se pudo inicializar la base de datos:', e);
    process.exit(1);
  });
