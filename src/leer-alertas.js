// ─── Lector de feeds RSS de Google Alerts ───
// Lee cada fuente registrada, extrae las menciones nuevas y las guarda.
import { pool } from './db.js';

// Quita etiquetas HTML de un texto
function limpiarHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

// Extrae el contenido de una etiqueta simple
function entre(texto, etiqueta) {
  const re = new RegExp(`<${etiqueta}[^>]*>([\\s\\S]*?)<\\/${etiqueta}>`, 'i');
  const m = texto.match(re);
  return m ? m[1] : '';
}

// El link de Google Alerts viene como atributo href; y a veces envuelto en redirect
function extraerLink(entry) {
  const m = entry.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (!m) return '';
  let url = m[1];
  // Google envuelve el link real en ?url=... ; lo desenvolvemos
  const inner = url.match(/[?&]url=([^&]+)/);
  if (inner) { try { url = decodeURIComponent(inner[1]); } catch {} }
  return url;
}

// Parsea un feed Atom/RSS de Google Alerts y devuelve las entradas
function parsearFeed(xml) {
  const entradas = [];
  // Google Alerts usa formato Atom: <entry>...</entry>
  const bloques = xml.split(/<entry[\s>]/i).slice(1);
  for (const b of bloques) {
    const entry = '<entry ' + b;
    const titulo = limpiarHtml(entre(entry, 'title'));
    const contenido = limpiarHtml(entre(entry, 'content'));
    const enlace = extraerLink(entry);
    const publicado = entre(entry, 'published') || entre(entry, 'updated');
    const guid = limpiarHtml(entre(entry, 'id')) || enlace;
    if (titulo) entradas.push({ titulo, contenido, enlace, publicado, guid });
  }
  return entradas;
}

// Lee UNA fuente y guarda sus menciones nuevas. Devuelve cuántas nuevas encontró.
async function leerFuente(fuente) {
  let nuevas = 0;
  try {
    const resp = await fetch(fuente.url, { headers: { 'User-Agent': 'Mozilla/5.0 (EMETRA-Sentinela)' } });
    if (!resp.ok) return 0;
    const xml = await resp.text();
    const entradas = parsearFeed(xml);
    for (const e of entradas) {
      // Inserta si el guid no existe (evita duplicados)
      const r = await pool.query(
        `INSERT INTO menciones_alertas (fuente_id, fuente_nombre, titulo, enlace, resumen, publicado, guid)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (guid) DO NOTHING RETURNING id`,
        [fuente.id, fuente.nombre, e.titulo, e.enlace, e.contenido,
         e.publicado ? new Date(e.publicado) : null, e.guid]
      );
      if (r.rowCount > 0) nuevas++;
    }
  } catch (err) {
    console.error('Error leyendo fuente', fuente.nombre, err.message);
  }
  return nuevas;
}

// Lee TODAS las fuentes activas. Devuelve el total de menciones nuevas.
export async function leerTodasLasAlertas() {
  const { rows: fuentes } = await pool.query('SELECT * FROM fuentes_rss WHERE activa = true');
  let total = 0;
  for (const f of fuentes) {
    total += await leerFuente(f);
  }
  return { fuentes: fuentes.length, nuevas: total };
}
