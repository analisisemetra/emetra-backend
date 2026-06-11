// ─── Procesador de la plantilla de Métricas (.xlsx) ───
// Lee las hojas Publicaciones, Credibilidad y Zonas y las guarda en la base.
import XLSX from 'xlsx';
import { pool } from './db.js';

// Convierte un valor a número entero seguro
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Busca una hoja por nombre, sin importar mayúsculas/espacios
function buscarHoja(wb, nombre) {
  const limpio = nombre.toLowerCase().trim();
  const encontrada = wb.SheetNames.find(n => n.toLowerCase().trim() === limpio);
  return encontrada ? wb.Sheets[encontrada] : null;
}

export async function procesarMetricas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const resumen = { publicaciones: 0, credibilidad: 0, zonas: 0 };

  // ── HOJA PUBLICACIONES ──
  const hPub = buscarHoja(wb, 'Publicaciones');
  if (hPub) {
    const filas = XLSX.utils.sheet_to_json(hPub, { defval: '' });
    await pool.query('DELETE FROM publicaciones'); // reemplaza todo (la plantilla es la verdad)
    for (const f of filas) {
      const texto = String(f['Texto/Título del post'] ?? f['Texto'] ?? '').trim();
      const red = String(f['Red Social'] ?? f['Red'] ?? '').trim();
      const tema = String(f['Tema'] ?? '').trim();
      if (!red && !tema && !texto) continue; // fila vacía
      if (texto.startsWith('↑') || red.startsWith('↑')) continue; // fila de nota
      let fecha = null;
      const fv = f['Fecha'];
      if (fv instanceof Date && !isNaN(fv)) fecha = fv.toISOString().slice(0, 10);
      else if (fv) { const d = new Date(fv); if (!isNaN(d)) fecha = d.toISOString().slice(0, 10); }
      await pool.query(
        `INSERT INTO publicaciones (fecha, red, tema, texto, alcance, plays, likes, comentarios, compartidos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [fecha, red, tema, texto,
         num(f['Alcance']), num(f['Plays/Vistas'] ?? f['Plays']), num(f['Likes']),
         num(f['Comentarios']), num(f['Compartidos'])]
      );
      resumen.publicaciones++;
    }
  }

  // ── HOJA CREDIBILIDAD ──
  const hCred = buscarHoja(wb, 'Credibilidad');
  if (hCred) {
    const filas = XLSX.utils.sheet_to_json(hCred, { defval: '' });
    await pool.query('DELETE FROM credibilidad');
    for (const f of filas) {
      const entidad = String(f['Entidad'] ?? '').trim();
      if (!entidad || entidad.startsWith('↑') || entidad.length > 60) continue;
      await pool.query(
        `INSERT INTO credibilidad (entidad, puntaje, respuesta, transparencia, consistencia, cercania)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (entidad) DO UPDATE SET puntaje=$2, respuesta=$3, transparencia=$4, consistencia=$5, cercania=$6`,
        [entidad, num(f['Puntaje (0-100)'] ?? f['Puntaje']),
         num(f['Respuesta a denuncias (%)'] ?? f['Respuesta']),
         num(f['Transparencia (%)'] ?? f['Transparencia']),
         num(f['Consistencia (%)'] ?? f['Consistencia']),
         num(f['Cercanía ciudadana (%)'] ?? f['Cercanía'] ?? f['Cercania'])]
      );
      resumen.credibilidad++;
    }
  }

  // ── HOJA ZONAS ──
  const hZon = buscarHoja(wb, 'Zonas');
  if (hZon) {
    const filas = XLSX.utils.sheet_to_json(hZon, { defval: '' });
    await pool.query('DELETE FROM zonas');
    for (const f of filas) {
      const zona = String(f['Zona'] ?? '').trim();
      if (!zona || zona.startsWith('↑') || zona.length > 40) continue;
      await pool.query(
        `INSERT INTO zonas (zona, menciones, nota) VALUES ($1,$2,$3)
         ON CONFLICT (zona) DO UPDATE SET menciones=$2, nota=$3`,
        [zona, num(f['Menciones']), String(f['Nota/Detalle'] ?? f['Nota'] ?? '').trim()]
      );
      resumen.zonas++;
    }
  }

  // ── HOJA DENUNCIAS ──
  const hDen = buscarHoja(wb, 'Denuncias');
  if (hDen) {
    const filas = XLSX.utils.sheet_to_json(hDen, { defval: '' });
    await pool.query('DELETE FROM denuncias');
    for (const f of filas) {
      const desc = String(f['Descripción'] ?? f['Descripcion'] ?? '').trim();
      if (!desc || desc.startsWith('↑')) continue;
      let fecha = null;
      const fv = f['Fecha'];
      if (fv instanceof Date && !isNaN(fv)) fecha = fv.toISOString().slice(0,10);
      else if (fv) { const d = new Date(fv); if (!isNaN(d)) fecha = d.toISOString().slice(0,10); }
      await pool.query(
        `INSERT INTO denuncias (fecha, zona, tipo, descripcion, estado) VALUES ($1,$2,$3,$4,$5)`,
        [fecha, String(f['Zona']??'').trim(), String(f['Tipo']??'').trim(), desc, String(f['Estado']??'Pendiente').trim()]
      );
      resumen.denuncias = (resumen.denuncias||0) + 1;
    }
  }

  // ── HOJA PROYECTOS ──
  const hPro = buscarHoja(wb, 'Proyectos');
  if (hPro) {
    const filas = XLSX.utils.sheet_to_json(hPro, { defval: '' });
    await pool.query('DELETE FROM proyectos_metricas');
    for (const f of filas) {
      const proyecto = String(f['Proyecto'] ?? '').trim();
      if (!proyecto || proyecto.startsWith('↑')) continue;
      await pool.query(
        `INSERT INTO proyectos_metricas (proyecto, aceptacion, menciones, positivo, negativo, tendencia)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (proyecto) DO UPDATE SET aceptacion=$2, menciones=$3, positivo=$4, negativo=$5, tendencia=$6`,
        [proyecto, num(f['Aceptación (%)']??f['Aceptación']), num(f['Menciones']),
         num(f['% Positivo']), num(f['% Negativo']), num(f['Tendencia (pts 6 meses)']??f['Tendencia'])]
      );
      resumen.proyectos = (resumen.proyectos||0) + 1;
    }
  }

  // ── HOJA CRISIS DIARIA ──
  const hCri = buscarHoja(wb, 'Crisis Diaria');
  if (hCri) {
    const filas = XLSX.utils.sheet_to_json(hCri, { defval: '' });
    await pool.query('DELETE FROM crisis_diaria');
    for (const f of filas) {
      const fv = f['Fecha'];
      let fecha = null;
      if (fv instanceof Date && !isNaN(fv)) fecha = fv.toISOString().slice(0,10);
      else if (fv) { const d = new Date(fv); if (!isNaN(d)) fecha = d.toISOString().slice(0,10); }
      if (!fecha) continue;
      await pool.query(
        `INSERT INTO crisis_diaria (fecha, menciones) VALUES ($1,$2)
         ON CONFLICT (fecha) DO UPDATE SET menciones=$2`,
        [fecha, num(f['Menciones ese día']??f['Menciones'])]
      );
      resumen.crisis = (resumen.crisis||0) + 1;
    }
  }

  // ── HOJA ENGAGEMENT CANAL ──
  const hEng = buscarHoja(wb, 'Engagement Canal');
  if (hEng) {
    const filas = XLSX.utils.sheet_to_json(hEng, { defval: '' });
    await pool.query('DELETE FROM engagement_canal');
    for (const f of filas) {
      const canal = String(f['Canal'] ?? '').trim();
      if (!canal || canal.startsWith('↑')) continue;
      const er = parseFloat(String(f['Engagement Rate (%)']??f['Engagement Rate']??0).replace(/[^\d.]/g,'')) || 0;
      await pool.query(
        `INSERT INTO engagement_canal (canal, er) VALUES ($1,$2)
         ON CONFLICT (canal) DO UPDATE SET er=$2`,
        [canal, er]
      );
      resumen.engagement = (resumen.engagement||0) + 1;
    }
  }

  // ── HOJA SENTIMIENTO POR TEMA ──
  const hST = buscarHoja(wb, 'Sentimiento por Tema');
  if (hST) {
    const filas = XLSX.utils.sheet_to_json(hST, { defval: '' });
    await pool.query('DELETE FROM sentimiento_tema');
    for (const f of filas) {
      const tema = String(f['Tema'] ?? '').trim();
      if (!tema || tema.startsWith('↑')) continue;
      await pool.query(
        `INSERT INTO sentimiento_tema (tema, positivos, negativos, neutros) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tema) DO UPDATE SET positivos=$2, negativos=$3, neutros=$4`,
        [tema, num(f['Positivos']), num(f['Negativos']), num(f['Neutros'])]
      );
      resumen.sentTema = (resumen.sentTema||0) + 1;
    }
  }

  // ── HOJA SENTIMIENTO SEMANAL ──
  const hSS = buscarHoja(wb, 'Sentimiento Semanal');
  if (hSS) {
    const filas = XLSX.utils.sheet_to_json(hSS, { defval: '' });
    await pool.query('DELETE FROM sentimiento_semanal');
    for (const f of filas) {
      const semana = String(f['Semana'] ?? '').trim();
      if (!semana || semana.startsWith('↑')) continue;
      await pool.query(
        `INSERT INTO sentimiento_semanal (semana, positivos, negativos) VALUES ($1,$2,$3)
         ON CONFLICT (semana) DO UPDATE SET positivos=$2, negativos=$3`,
        [semana, num(f['Positivos']), num(f['Negativos'])]
      );
      resumen.semanal = (resumen.semanal||0) + 1;
    }
  }

  return resumen;
}
