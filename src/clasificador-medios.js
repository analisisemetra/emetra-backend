// ─── Clasificador de medios: analiza cómo trata cada noticia RSS a tus ───
// entidades (favor/contra/neutral) y mantiene actualizado el actor de cada
// medio automáticamente — sin que tengas que capturar noticias a mano.
import { pool } from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-haiku-4-5-20251001'; // barato, es solo clasificación de titulares
const LOTE = 15;

export function hayApiKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function clasificarLote(items) {
  const lista = items.map((it, i) => `${i + 1}. "${it.titulo}"${it.resumen ? ' — ' + String(it.resumen).slice(0, 200) : ''}`).join('\n');
  const prompt = `Eres analista de medios para EMETRA/PMT (tránsito de Ciudad de Guatemala). Para cada titular/resumen de noticia, clasifica cómo trata a EMETRA, la PMT, o sus funcionarios (Héctor Flores, Montejo, etc.).

- postura: "favor" (cobertura positiva, destaca logros), "contra" (crítica, denuncia, señala fallas), o "neutral" (informativa, sin juicio, o no menciona directamente a estas entidades)
- motivo: por qué, en máximo 8 palabras

Noticias:
${lista}

Responde SOLO con un arreglo JSON, sin texto adicional:
[{"postura":"...","motivo":"..."}, ...]
Un objeto por noticia, mismo orden.`;

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELO, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`API Anthropic respondió ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  let txt = (data.content || []).map(b => b.text || '').join('').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(txt);
}

// Clasifica las alertas RSS pendientes (sin sentimiento_medio) y actualiza los actores tipo "medio"
export async function clasificarAlertasPendientes() {
  if (!hayApiKey()) return { clasificadas: 0 };
  const { rows: pendientes } = await pool.query(
    `SELECT id, fuente_nombre, titulo, resumen FROM menciones_alertas WHERE sentimiento_medio IS NULL ORDER BY creado_en DESC LIMIT 150`
  );
  if (pendientes.length === 0) return { clasificadas: 0 };

  let clasificadas = 0;
  for (let i = 0; i < pendientes.length; i += LOTE) {
    const grupo = pendientes.slice(i, i + LOTE);
    try {
      const resultados = await clasificarLote(grupo);
      for (let j = 0; j < grupo.length; j++) {
        const r = resultados[j] || {};
        const postura = ['favor', 'contra', 'neutral'].includes(r.postura) ? r.postura : 'neutral';
        await pool.query(
          `UPDATE menciones_alertas SET sentimiento_medio=$1, motivo_medio=$2 WHERE id=$3`,
          [postura, (r.motivo || '').slice(0, 150), grupo[j].id]
        );
        clasificadas++;
      }
    } catch (e) {
      console.error('Clasificando medios, error en lote:', e.message);
      // marca el lote como neutral para no reintentar en bucle infinito
      for (const g of grupo) {
        await pool.query(`UPDATE menciones_alertas SET sentimiento_medio='neutral', motivo_medio='Sin clasificar (error IA)' WHERE id=$1`, [g.id]);
      }
    }
  }

  // Actualiza/crea el actor de cada medio con su postura agregada (últimas 20 notas de ese medio)
  const { rows: medios } = await pool.query(`SELECT DISTINCT fuente_nombre FROM menciones_alertas WHERE fuente_nombre IS NOT NULL AND sentimiento_medio IS NOT NULL`);
  for (const m of medios) {
    const { rows: recientes } = await pool.query(
      `SELECT sentimiento_medio FROM menciones_alertas WHERE fuente_nombre=$1 AND sentimiento_medio IS NOT NULL ORDER BY creado_en DESC LIMIT 20`,
      [m.fuente_nombre]
    );
    const total = recientes.length || 1;
    const favor = recientes.filter(r => r.sentimiento_medio === 'favor').length;
    const contra = recientes.filter(r => r.sentimiento_medio === 'contra').length;
    let posturaAgregada = 'neutral';
    if (favor / total >= 0.5) posturaAgregada = 'favor';
    else if (contra / total >= 0.5) posturaAgregada = 'contra';

    const existe = await pool.query(`SELECT id FROM actores WHERE lower(nombre) = lower($1) LIMIT 1`, [m.fuente_nombre]);
    if (existe.rows.length > 0) {
      await pool.query(`UPDATE actores SET postura=$1, tipo='medio' WHERE id=$2`, [posturaAgregada, existe.rows[0].id]);
    } else {
      await pool.query(
        `INSERT INTO actores (nombre, tipo, postura, notas) VALUES ($1,'medio',$2,'Actualizado automáticamente de RSS')`,
        [m.fuente_nombre, posturaAgregada]
      );
    }
  }

  return { clasificadas };
}

// Ranking de "ambiente en medios": cada medio con cuántas veces te menciona y su favorabilidad
export async function ambienteMedios() {
  const { rows } = await pool.query(`
    SELECT fuente_nombre,
           COUNT(*)::int AS total,
           SUM(CASE WHEN sentimiento_medio='favor' THEN 1 ELSE 0 END)::int AS favor,
           SUM(CASE WHEN sentimiento_medio='contra' THEN 1 ELSE 0 END)::int AS contra,
           SUM(CASE WHEN sentimiento_medio='neutral' THEN 1 ELSE 0 END)::int AS neutral,
           MAX(publicado) AS ultima
    FROM menciones_alertas
    WHERE fuente_nombre IS NOT NULL AND sentimiento_medio IS NOT NULL
    GROUP BY fuente_nombre
    ORDER BY total DESC`);
  return rows.map(r => {
    const tot = r.total || 1;
    const pctFavor = Math.round(r.favor / tot * 100);
    const pctContra = Math.round(r.contra / tot * 100);
    let postura = 'neutral';
    if (r.favor / tot >= 0.5) postura = 'favor';
    else if (r.contra / tot >= 0.5) postura = 'contra';
    return { medio: r.fuente_nombre, total: r.total, favor: r.favor, contra: r.contra, neutral: r.neutral, pctFavor, pctContra, postura, ultima: r.ultima };
  });
}
