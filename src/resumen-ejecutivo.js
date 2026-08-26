// ─── Resumen ejecutivo automático con IA ───
// Recopila el estado de la conversación (sentimiento, dolores, denuncias,
// amenazas, alertas de medios) y le pide a la IA un resumen ejecutivo
// pensado para que el Gerente General lo lea en 1 minuto.
//
// Usa un modelo más potente que el clasificador porque aquí la calidad del
// análisis importa más que el costo (es para decisiones).
import { pool } from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-sonnet-4-6'; // más potente para análisis ejecutivo

export function hayApiKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Recopila todos los datos relevantes del estado actual
async function recopilarContexto() {
  const ctx = {};

  // Sentimiento general
  const sent = await pool.query(`
    SELECT sentimiento, COUNT(*)::int AS n FROM menciones GROUP BY sentimiento`);
  ctx.sentimiento = { positivo: 0, negativo: 0, neutro: 0 };
  sent.rows.forEach(r => { ctx.sentimiento[r.sentimiento] = r.n; });
  ctx.totalComentarios = ctx.sentimiento.positivo + ctx.sentimiento.negativo + ctx.sentimiento.neutro;

  // Dolores más mencionados (agrupados a lo bruto por texto del dolor)
  const dolores = await pool.query(`
    SELECT dolor, COUNT(*)::int AS n FROM menciones
    WHERE dolor IS NOT NULL AND dolor <> '' GROUP BY dolor ORDER BY n DESC LIMIT 20`);
  ctx.dolores = dolores.rows;

  // Emociones dominantes
  const emo = await pool.query(`
    SELECT emocion, COUNT(*)::int AS n FROM menciones
    WHERE emocion IS NOT NULL GROUP BY emocion ORDER BY n DESC LIMIT 8`);
  ctx.emociones = emo.rows;

  // Zonas más críticas (por negativos)
  const zonas = await pool.query(`
    SELECT zona, COUNT(*)::int AS total,
           SUM(CASE WHEN sentimiento='negativo' THEN 1 ELSE 0 END)::int AS negativos
    FROM menciones WHERE zona IS NOT NULL AND zona <> ''
    GROUP BY zona ORDER BY negativos DESC LIMIT 8`);
  ctx.zonas = zonas.rows;

  // Denuncias concretas recientes (negativos con ubicación)
  const denuncias = await pool.query(`
    SELECT zona, direccion, dolor, senalado, texto FROM menciones
    WHERE sentimiento='negativo' AND (zona IS NOT NULL OR direccion IS NOT NULL)
    ORDER BY fecha DESC NULLS LAST LIMIT 15`);
  ctx.denuncias = denuncias.rows;

  // Comentarios más intensos (los reclamos/elogios más fuertes)
  const intensos = await pool.query(`
    SELECT resumen, sentimiento, emocion, intensidad FROM menciones
    WHERE resumen IS NOT NULL AND intensidad >= 4
    ORDER BY intensidad DESC LIMIT 15`);
  ctx.intensos = intensos.rows;

  // Alertas de medios recientes
  const alertas = await pool.query(`
    SELECT titulo, fuente FROM menciones_alertas
    ORDER BY fecha_pub DESC NULLS LAST LIMIT 15`).catch(() => ({ rows: [] }));
  ctx.alertas = alertas.rows;

  // Credibilidad actual
  const cred = await pool.query(`SELECT entidad, puntaje FROM credibilidad ORDER BY puntaje DESC`).catch(() => ({ rows: [] }));
  ctx.credibilidad = cred.rows;

  return ctx;
}

// Construye el prompt para la IA con todo el contexto
function construirPrompt(ctx) {
  const pct = (n) => ctx.totalComentarios ? Math.round(n / ctx.totalComentarios * 100) : 0;
  const lineas = [];
  lineas.push(`Total de comentarios analizados: ${ctx.totalComentarios}`);
  lineas.push(`Sentimiento: ${pct(ctx.sentimiento.positivo)}% positivo, ${pct(ctx.sentimiento.negativo)}% negativo, ${pct(ctx.sentimiento.neutro)}% neutro`);
  if (ctx.emociones.length) lineas.push(`Emociones dominantes: ${ctx.emociones.map(e => `${e.emocion} (${e.n})`).join(', ')}`);
  if (ctx.dolores.length) lineas.push(`Principales reclamos: ${ctx.dolores.map(d => `${d.dolor} (${d.n})`).join('; ')}`);
  if (ctx.zonas.length) lineas.push(`Zonas con más quejas: ${ctx.zonas.map(z => `${z.zona}: ${z.negativos} negativos de ${z.total}`).join('; ')}`);
  if (ctx.denuncias.length) lineas.push(`Denuncias concretas recientes:\n${ctx.denuncias.map(d => `  - ${d.zona || ''} ${d.direccion || ''} | ${d.dolor || ''} | contra: ${d.senalado || 'no especifica'}`).join('\n')}`);
  if (ctx.intensos.length) lineas.push(`Comentarios más intensos: ${ctx.intensos.map(i => `${i.resumen} (${i.sentimiento}, ${i.emocion})`).join('; ')}`);
  if (ctx.alertas.length) lineas.push(`Noticias/menciones en medios recientes: ${ctx.alertas.map(a => a.titulo).join('; ')}`);
  if (ctx.credibilidad.length) lineas.push(`Credibilidad actual: ${ctx.credibilidad.map(c => `${c.entidad}: ${c.puntaje}/100`).join(', ')}`);

  return `Eres el analista de inteligencia mediática de confianza del Gerente General de EMETRA (tránsito de Ciudad de Guatemala). Con los datos de abajo, redacta un RESUMEN EJECUTIVO que él pueda leer en 1 minuto y saber cómo está la reputación de la institución.

DATOS ACTUALES:
${lineas.join('\n')}

Redacta el resumen en español, tono profesional y directo (sin rodeos ni palabras de relleno). Este resumen es solo ANÁLISIS de lo que está pasando — NO sugieras qué hacer ni des consejos ni recomendaciones de acción; eso lo decide el Gerente General con estos datos. Estructura EXACTA en JSON:
{
  "titular": "una frase que capture el estado general (máximo 15 palabras)",
  "panorama": "2-3 frases sobre qué está pasando en la conversación pública",
  "preocupaciones": ["3 a 5 focos rojos concretos, cada uno una frase con el dato que lo respalda"],
  "positivo": ["1 a 3 cosas que están funcionando bien"],
  "nivel_riesgo": "bajo" | "medio" | "alto"
}

Sé específico: usa los números y zonas reales. Responde SOLO con el JSON, sin markdown ni texto adicional.`;
}

// Genera el resumen ejecutivo
export async function generarResumenEjecutivo() {
  const ctx = await recopilarContexto();
  if (ctx.totalComentarios === 0) {
    return { vacio: true, mensaje: 'Aún no hay comentarios analizados para generar un resumen.' };
  }
  const prompt = construirPrompt(ctx);

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API Anthropic respondió ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  let txt = (data.content || []).map(b => b.text || '').join('').trim();
  txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
  const resumen = JSON.parse(txt);
  resumen.generado_en = new Date().toISOString();
  resumen.total_comentarios = ctx.totalComentarios;
  return resumen;
}
