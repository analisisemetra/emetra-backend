// ─── Alertas de crisis automáticas ───
// Filosofía: primero se hacen chequeos estadísticos BARATOS (sin usar IA).
// Solo si algo realmente cruza un umbral, se le pide a la IA que redacte
// una alerta clara con explicación y recomendación. Así no se gasta
// presupuesto de IA revisando algo que no lo amerita.
import { pool } from './db.js';
import { analizarAmenazas } from './amenazas.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-sonnet-4-6'; // igual que el resumen ejecutivo: aquí la calidad importa
const COOLDOWN_HORAS = 3; // no repetir alertas si ya se generó una hace poco

// ── Chequeos estadísticos (todos rápidos, sin IA) ──
async function chequearSentimiento() {
  const r24 = await pool.query(`
    SELECT COUNT(*)::int AS total, SUM(CASE WHEN sentimiento='negativo' THEN 1 ELSE 0 END)::int AS neg
    FROM menciones WHERE fecha >= now() - interval '24 hours'`);
  const rBase = await pool.query(`
    SELECT COUNT(*)::int AS total, SUM(CASE WHEN sentimiento='negativo' THEN 1 ELSE 0 END)::int AS neg
    FROM menciones WHERE fecha >= now() - interval '30 days' AND fecha < now() - interval '24 hours'`);
  const hoy = r24.rows[0], base = rBase.rows[0];
  if (!hoy.total || hoy.total < 5) return null; // muy poco volumen para ser señal confiable
  const pctHoy = hoy.neg / hoy.total;
  const pctBase = base.total > 0 ? base.neg / base.total : pctHoy;
  const salto = pctHoy - pctBase;
  if (pctHoy >= 0.6 && salto >= 0.15) {
    return { tipo: 'sentimiento', dato: `Negatividad de las últimas 24h: ${Math.round(pctHoy * 100)}% (antes: ${Math.round(pctBase * 100)}%), sobre ${hoy.total} menciones.` };
  }
  return null;
}

async function chequearTema() {
  const { rows } = await pool.query(`
    SELECT dolor, COUNT(*)::int AS n FROM menciones
    WHERE fecha >= now() - interval '48 hours' AND dolor IS NOT NULL AND dolor <> ''
    GROUP BY dolor HAVING COUNT(*) >= 5 ORDER BY n DESC LIMIT 5`);
  if (rows.length === 0) return null;
  const picos = [];
  for (const r of rows) {
    const hist = await pool.query(`
      SELECT COUNT(*)::int AS n, COUNT(DISTINCT fecha::date)::int AS dias
      FROM menciones WHERE dolor = $1 AND fecha < now() - interval '48 hours' AND fecha >= now() - interval '30 days'`, [r.dolor]);
    const diasHist = Math.max(hist.rows[0].dias, 1);
    const promDiario = hist.rows[0].n / diasHist;
    const ritmoActual = r.n / 2; // por día, en la ventana de 48h
    if (promDiario > 0 && ritmoActual >= promDiario * 3) {
      picos.push(`"${r.dolor}" (${r.n} menciones en 48h, antes ~${promDiario.toFixed(1)}/día)`);
    } else if (promDiario === 0 && r.n >= 8) {
      picos.push(`"${r.dolor}" (${r.n} menciones en 48h, tema nuevo)`);
    }
  }
  if (picos.length === 0) return null;
  return { tipo: 'tema', dato: `Temas en alza repentina: ${picos.join('; ')}.` };
}

async function chequearCoordinado() {
  const analisis = await analizarAmenazas();
  const altaRecientes = analisis.cuentas.filter(c => c.nivel === 'ALTA' && c.bando === 'hostil');
  const sincronia = analisis.patrones.sincronia.length;
  if (altaRecientes.length >= 2 || sincronia >= 3) {
    return {
      tipo: 'coordinado',
      dato: `${altaRecientes.length} cuenta(s) de hostilidad ALTA activas y ${sincronia} pares de sincronía temporal detectados (posible coordinación).`,
    };
  }
  return null;
}

async function chequearVolumen() {
  const r24 = await pool.query(`SELECT COUNT(*)::int AS n FROM menciones WHERE fecha >= now() - interval '24 hours'`);
  const rProm = await pool.query(`
    SELECT COUNT(*)::int AS n, COUNT(DISTINCT fecha::date)::int AS dias
    FROM menciones WHERE fecha >= now() - interval '30 days' AND fecha < now() - interval '24 hours'`);
  const hoy = r24.rows[0].n;
  const dias = Math.max(rProm.rows[0].dias, 1);
  const promedio = rProm.rows[0].n / dias;
  if (promedio >= 3 && hoy >= promedio * 2.5) {
    return { tipo: 'volumen', dato: `${hoy} menciones en las últimas 24h, frente a un promedio de ${promedio.toFixed(1)}/día — pico de actividad.` };
  }
  return null;
}

// ── Evaluación principal ──
// forzar=true: ignora el cooldown (para el botón "Evaluar ahora" manual)
export async function evaluarCrisis(forzar = false) {
  if (!forzar) {
    const { rows } = await pool.query(`SELECT creado_en FROM alertas_crisis ORDER BY creado_en DESC LIMIT 1`);
    if (rows.length > 0) {
      const horas = (Date.now() - new Date(rows[0].creado_en).getTime()) / 3600000;
      if (horas < COOLDOWN_HORAS) return { generada: false, motivo: 'cooldown' };
    }
  }

  const senales = (await Promise.all([chequearSentimiento(), chequearTema(), chequearCoordinado(), chequearVolumen()])).filter(Boolean);

  if (senales.length === 0) return { generada: false, motivo: 'sin_senales' };

  if (!process.env.ANTHROPIC_API_KEY) {
    // sin IA disponible: guarda una alerta básica con los datos crudos, sin redacción
    const tipo = senales[0].tipo;
    const { rows } = await pool.query(
      `INSERT INTO alertas_crisis (tipo, severidad, titulo, explicacion, recomendacion) VALUES ($1,'media',$2,$3,$4) RETURNING *`,
      [tipo, 'Señal detectada: ' + tipo, senales.map(s => s.dato).join(' '), 'Revisa el panel para más detalle.']
    );
    return { generada: true, alerta: rows[0] };
  }

  // Le pide a la IA que redacte la alerta con las señales activas
  const prompt = `Eres el sistema de vigilancia automática de EMETRA/PMT (tránsito de Ciudad de Guatemala). Se detectaron estas señales en la conversación pública de las últimas horas:

${senales.map((s, i) => `${i + 1}. [${s.tipo}] ${s.dato}`).join('\n')}

Redacta una alerta ejecutiva breve y clara. Responde SOLO con este JSON:
{
  "severidad": "media" | "alta" | "critica",
  "titulo": "una frase que resuma la alerta (máximo 12 palabras)",
  "explicacion": "2-3 frases explicando qué está pasando y por qué importa",
  "recomendacion": "una acción concreta e inmediata a tomar"
}
Sé directo, sin relleno. Si hay señal de "coordinado", trata la alerta como más seria (alta o critica).`;

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELO, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`API Anthropic respondió ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  let txt = (data.content || []).map(b => b.text || '').join('').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  const redactada = JSON.parse(txt);

  const { rows } = await pool.query(
    `INSERT INTO alertas_crisis (tipo, severidad, titulo, explicacion, recomendacion) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [senales.map(s => s.tipo).join('+'), redactada.severidad || 'media', redactada.titulo, redactada.explicacion, redactada.recomendacion]
  );
  return { generada: true, alerta: rows[0] };
}
