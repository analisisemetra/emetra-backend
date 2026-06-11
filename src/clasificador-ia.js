// ─── Clasificador inteligente vía API de Anthropic (Claude) ───
// Si hay ANTHROPIC_API_KEY en el entorno, clasifica con Claude (entiende
// sarcasmo, contexto, peticiones). Si no, el sistema usa el clasificador
// básico por léxico (no se rompe nada).
//
// Procesa en LOTES para ser eficiente y barato: manda varios comentarios
// en una sola llamada y recibe la clasificación de todos.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-haiku-4-5-20251001'; // rápido y barato para clasificar miles
const LOTE = 20; // comentarios por llamada

export function hayApiKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Clasifica un lote de textos. Devuelve un arreglo con { sentimiento, dolor, postura, confianza }
async function clasificarLote(textos) {
  const lista = textos.map((t, i) => `${i + 1}. ${String(t).replace(/\n/g, ' ').slice(0, 400)}`).join('\n');
  const prompt = `Eres analista de sentimiento para EMETRA/PMT (tránsito de Ciudad de Guatemala). Clasifica cada comentario ciudadano. Entiende el español guatemalteco, el sarcasmo y las quejas indirectas.

Para cada comentario devuelve:
- sentimiento: "positivo" (apoya/felicita), "negativo" (critica/ataca/se queja con molestia), o "neutro" (pregunta/comenta sin carga)
- dolor: el problema concreto que menciona en pocas palabras (ej: "motos en banqueta", "ventas que apartan parqueo", "falta de operativos", "multas injustas"), o null si no menciona ninguno
- postura: "aliado" (apoya a EMETRA/PMT), "critico" (en contra), o "neutral"

Ojo: una petición como "por favor vengan a la zona 1" o "para cuándo en zona 4" suele ser un ciudadano que APOYA los operativos y pide más (postura aliado, sentimiento positivo o neutro). El sarcasmo como "solo cuando hay cámaras 🤣" es crítica (negativo, critico).

Comentarios:
${lista}

Responde SOLO con un arreglo JSON válido, sin texto adicional, sin markdown. Formato exacto:
[{"sentimiento":"...","dolor":"..." o null,"postura":"..."}, ...]
Un objeto por comentario, en el mismo orden.`;

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API Anthropic respondió ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  let txt = (data.content || []).map(b => b.text || '').join('').trim();
  // limpia posibles fences de markdown
  txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
  const arr = JSON.parse(txt);
  return arr;
}

// Clasifica muchos textos en lotes. Devuelve arreglo alineado con la entrada.
// Cada item: { sentimiento, confianza, dolor, postura }
export async function clasificarConIA(textos) {
  const resultados = [];
  for (let i = 0; i < textos.length; i += LOTE) {
    const grupo = textos.slice(i, i + LOTE);
    try {
      const clas = await clasificarLote(grupo);
      for (let j = 0; j < grupo.length; j++) {
        const c = clas[j] || {};
        resultados.push({
          sentimiento: ['positivo', 'negativo', 'neutro'].includes(c.sentimiento) ? c.sentimiento : 'neutro',
          confianza: 0.9, // la IA es confiable; no marcamos como dudoso
          dolor: c.dolor && c.dolor !== 'null' ? String(c.dolor).slice(0, 80) : null,
          postura: ['aliado', 'critico', 'neutral'].includes(c.postura) ? c.postura : 'neutral',
        });
      }
    } catch (e) {
      // si un lote falla, marca esos como neutros para no perder el flujo
      console.error('Error clasificando lote con IA:', e.message);
      for (let j = 0; j < grupo.length; j++) {
        resultados.push({ sentimiento: 'neutro', confianza: 0.3, dolor: null, postura: 'neutral' });
      }
    }
  }
  return resultados;
}
