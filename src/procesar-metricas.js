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

  return resumen;
}
