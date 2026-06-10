// ─── Procesador de archivos .xlsx de ExportComments ───
// Lee el archivo, encuentra la fila de encabezado real (ExportComments pone
// metadata arriba), clasifica cada comentario y lo guarda en la base.
import XLSX from 'xlsx';
import { pool } from './db.js';
import { clasificarSentimiento, detectarZona, UMBRAL_DUDOSO } from './sentimiento.js';

// Busca la fila que tiene los encabezados reales (Name, Comment, Date...)
function encontrarEncabezado(filas) {
  for (let i = 0; i < Math.min(filas.length, 15); i++) {
    const fila = (filas[i] || []).map(c => String(c ?? '').trim());
    const tieneComment = fila.some(c => /^comment$/i.test(c));
    const tieneName = fila.some(c => /^name$/i.test(c));
    if (tieneComment && tieneName) return i;
  }
  return -1;
}

// Convierte la fila de encabezado en un mapa { nombreColumna: índice }
function mapaColumnas(encabezado) {
  const mapa = {};
  encabezado.forEach((nombre, idx) => {
    const n = String(nombre ?? '').trim().toLowerCase();
    if (n === 'name') mapa.autor = idx;
    else if (n === 'profile id') mapa.profileId = idx;
    else if (n === 'date') mapa.fecha = idx;
    else if (n === 'likes') mapa.likes = idx;
    else if (n === 'comment') mapa.texto = idx;
    else if (n === 'comment permalink') mapa.permalink = idx;
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
    throw new Error('El archivo no tiene columna "Comment".');
  }

  // Crea el registro de la carga
  const cargaRes = await pool.query(
    `INSERT INTO cargas (archivo, fuente_url, subido_por) VALUES ($1,$2,$3) RETURNING id`,
    [archivo, fuenteUrl, subidoPor]
  );
  const cargaId = cargaRes.rows[0].id;

  let total = 0, positivos = 0, negativos = 0, neutros = 0, dudosos = 0;

  // Procesa cada fila de datos (después del encabezado)
  for (let i = idxEnc + 1; i < filas.length; i++) {
    const fila = filas[i] || [];
    const texto = String(fila[cols.texto] ?? '').trim();
    if (!texto) continue; // salta filas vacías

    const autor = cols.autor !== undefined ? String(fila[cols.autor] ?? '').trim() : '';
    const profileId = cols.profileId !== undefined ? String(fila[cols.profileId] ?? '').trim() : '';
    const permalink = cols.permalink !== undefined ? String(fila[cols.permalink] ?? '').trim() : '';
    let likes = 0;
    if (cols.likes !== undefined) {
      const l = parseInt(String(fila[cols.likes] ?? '').replace(/\D/g, ''));
      likes = isNaN(l) ? 0 : l;
    }
    let fecha = null;
    if (cols.fecha !== undefined) {
      const f = new Date(String(fila[cols.fecha] ?? ''));
      if (!isNaN(f.getTime())) fecha = f.toISOString();
    }

    const { sentimiento, confianza } = clasificarSentimiento(texto);
    const zona = detectarZona(texto);
    const esDudoso = confianza < UMBRAL_DUDOSO;

    await pool.query(
      `INSERT INTO menciones (carga_id, autor, profile_id, fecha, likes, texto, permalink, sentimiento, confianza, zona)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cargaId, autor, profileId, fecha, likes, texto, permalink, sentimiento, confianza, zona]
    );

    total++;
    if (sentimiento === 'positivo') positivos++;
    else if (sentimiento === 'negativo') negativos++;
    else neutros++;
    if (esDudoso) dudosos++;
  }

  // Actualiza el resumen de la carga
  await pool.query(
    `UPDATE cargas SET total=$1, positivos=$2, negativos=$3, neutros=$4, dudosos=$5 WHERE id=$6`,
    [total, positivos, negativos, neutros, dudosos, cargaId]
  );

  return { cargaId, archivo, total, positivos, negativos, neutros, dudosos };
}
