// ─── Procesador de archivos .xlsx de ExportComments ───
// Lee el archivo, encuentra la fila de encabezado real (ExportComments pone
// metadata arriba), clasifica cada comentario y lo guarda en la base.
import XLSX from 'xlsx';
import { pool } from './db.js';
import { clasificarSentimiento, detectarZona, detectarDolor, UMBRAL_DUDOSO } from './sentimiento.js';
import { hayApiKey, clasificarConIA } from './clasificador-ia.js';

// Busca la fila que tiene los encabezados reales (Name, Comment, Date...)
function encontrarEncabezado(filas) {
  for (let i = 0; i < Math.min(filas.length, 15); i++) {
    const fila = (filas[i] || []).map(c => String(c ?? '').trim().toLowerCase());
    const tieneTexto = fila.some(c => /^(comment|tweet text|text)$/i.test(c));
    const tieneNombre = fila.some(c => /^(name|username)$/i.test(c));
    if (tieneTexto && tieneNombre) return i;
  }
  return -1;
}

// Detecta de qué red es el archivo según sus columnas
function detectarRed(encabezado) {
  const cols = encabezado.map(c => String(c ?? '').trim().toLowerCase());
  if (cols.includes('tweet text') || cols.includes('author followers')) return 'X';
  if (cols.includes('unique id')) return 'TikTok';
  if (cols.includes('username') && cols.includes('profile id')) return 'Instagram';
  if (cols.includes('live video timestamp')) return 'Facebook';
  return 'Facebook'; // por defecto
}

// Mapea columnas según la red. Captura lo común + lo forense de X.
function mapaColumnas(encabezado) {
  const mapa = {};
  encabezado.forEach((nombre, idx) => {
    const n = String(nombre ?? '').trim().toLowerCase();
    // Texto del comentario (varía por red)
    if (n === 'comment' || n === 'tweet text' || n === 'text') mapa.texto = idx;
    // Nombre visible
    else if (n === 'name') mapa.autor = idx;
    // Usuario / handle
    else if (n === 'username' || n === 'unique id') mapa.username = idx;
    // Identificador único de persona
    else if (n === 'profile id') mapa.profileId = idx;
    // Fecha
    else if (n === 'date') mapa.fecha = idx;
    // Likes / favoritos
    else if (n === 'likes' || n === 'favorites') mapa.likes = idx;
    else if (n === 'comment permalink' || n === 'status url') mapa.permalink = idx;
    // ── Datos forenses de X/Twitter ──
    else if (n === 'author followers') mapa.followers = idx;
    else if (n === 'author friends') mapa.friends = idx;
    else if (n === 'author statuses') mapa.statuses = idx;
    else if (n === 'author bio') mapa.bio = idx;
    else if (n === 'author location') mapa.location = idx;
    else if (n === 'author verified') mapa.verified = idx;
    else if (n === 'is retweet?') mapa.isRetweet = idx;
  });
  return mapa;
}

// Procesa un buffer de archivo .xlsx. Devuelve un resumen de la carga.
export async function procesarXlsx(buffer, { archivo, subidoPor }) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  // Intenta leer la URL de origen (suele estar en las primeras filas)
  let fuenteUrl = '';
  for (let i = 0; i < Math.min(filas.length, 6); i++) {
    const fila = filas[i] || [];
    if (String(fila[0] ?? '').toLowerCase().includes('source url')) {
      fuenteUrl = String(fila[1] ?? '');
      break;
    }
  }

  const idxEnc = encontrarEncabezado(filas);
  if (idxEnc === -1) {
    throw new Error('No se encontró el encabezado del archivo. ¿Es un export de ExportComments?');
  }
  const cols = mapaColumnas(filas[idxEnc]);
  if (cols.texto === undefined) {
    throw new Error('El archivo no tiene columna de texto (Comment/Tweet Text).');
  }
  const red = detectarRed(filas[idxEnc]);

  // Crea el registro de la carga
  const cargaRes = await pool.query(
    `INSERT INTO cargas (archivo, fuente_url, subido_por) VALUES ($1,$2,$3) RETURNING id`,
    [archivo, fuenteUrl, subidoPor]
  );
  const cargaId = cargaRes.rows[0].id;

  let total = 0, positivos = 0, negativos = 0, neutros = 0, dudosos = 0;

  const valor = (fila, idx) => idx !== undefined ? String(fila[idx] ?? '').trim() : '';
  const numero = (fila, idx) => {
    if (idx === undefined) return null;
    const n = parseInt(String(fila[idx] ?? '').replace(/[^\d]/g, ''));
    return isNaN(n) ? null : n;
  };

  // 1) Recolecta todas las filas válidas
  const registros = [];
  for (let i = idxEnc + 1; i < filas.length; i++) {
    const fila = filas[i] || [];
    const texto = valor(fila, cols.texto);
    if (!texto) continue;
    let fecha = null;
    if (cols.fecha !== undefined) {
      const f = new Date(valor(fila, cols.fecha));
      if (!isNaN(f.getTime())) fecha = f.toISOString();
    }
    registros.push({
      texto,
      autor: valor(fila, cols.autor),
      username: valor(fila, cols.username),
      profileId: valor(fila, cols.profileId),
      permalink: valor(fila, cols.permalink),
      likes: numero(fila, cols.likes) || 0,
      fecha,
      followers: numero(fila, cols.followers),
      bio: valor(fila, cols.bio) || null,
      ubicacion: valor(fila, cols.location) || null,
      verificado: cols.verified !== undefined ? /^(yes|sí|si|true)$/i.test(valor(fila, cols.verified)) : null,
    });
  }

  // 2) Clasifica: con IA (Claude) si hay API key; si no, con el clasificador básico
  const usarIA = hayApiKey();
  let clasificaciones;
  if (usarIA && registros.length > 0) {
    try {
      clasificaciones = await clasificarConIA(registros.map(r => r.texto));
    } catch (e) {
      console.error('Falló la IA, usando clasificador básico:', e.message);
      clasificaciones = null;
    }
  }

  // 3) Inserta cada registro con su clasificación
  for (let k = 0; k < registros.length; k++) {
    const r = registros[k];
    let sentimiento, confianza, dolor, zona, direccion = null, senalado = null;
    let emocion = null, tema_ia = null, intensidad = null, resumen = null;
    if (clasificaciones && clasificaciones[k]) {
      const cl = clasificaciones[k];
      sentimiento = cl.sentimiento;
      confianza = cl.confianza;
      dolor = cl.dolor || detectarDolor(r.texto);
      zona = cl.zona || detectarZona(r.texto);
      direccion = cl.direccion || null;
      senalado = cl.senalado || null;
      emocion = cl.emocion || null;
      tema_ia = cl.tema || null;
      intensidad = cl.intensidad || null;
      resumen = cl.resumen || null;
    } else {
      const c = clasificarSentimiento(r.texto);
      sentimiento = c.sentimiento; confianza = c.confianza;
      dolor = detectarDolor(r.texto);
      zona = detectarZona(r.texto);
    }
    const esDudoso = confianza < UMBRAL_DUDOSO;

    await pool.query(
      `INSERT INTO menciones (carga_id, autor, profile_id, username, red, fecha, likes, texto, permalink, sentimiento, confianza, zona, dolor, followers, bio, ubicacion, verificado, direccion, senalado, emocion, tema_ia, intensidad, resumen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [cargaId, r.autor, r.profileId, r.username, red, r.fecha, r.likes, r.texto, r.permalink, sentimiento, confianza, zona, dolor, r.followers, r.bio, r.ubicacion, r.verificado, direccion, senalado, emocion, tema_ia, intensidad, resumen]
    );

    total++;
    if (sentimiento === 'positivo') positivos++;
    else if (sentimiento === 'negativo') negativos++;
    else neutros++;
    if (esDudoso) dudosos++;
  }

  await pool.query(
    `UPDATE cargas SET total=$1, positivos=$2, negativos=$3, neutros=$4, dudosos=$5 WHERE id=$6`,
    [total, positivos, negativos, neutros, dudosos, cargaId]
  );

  return { cargaId, archivo, red, total, positivos, negativos, neutros, dudosos, motor: usarIA ? 'IA' : 'básico' };
}
