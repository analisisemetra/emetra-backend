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
  const prompt = `Eres analista experto de sentimiento para EMETRA/PMT (tránsito de Ciudad de Guatemala). Analiza con cuidado cada comentario ciudadano. Entiende a fondo el español guatemalteco, los modismos, el sarcasmo y las quejas indirectas. Tómate el análisis en serio: la precisión importa.

Para cada comentario devuelve EXACTAMENTE estos campos:
- sentimiento: "positivo" (apoya/felicita/agradece), "negativo" (critica/ataca/se queja con molestia), o "neutro" (pregunta/comenta/informa sin carga emocional)
- emocion: la emoción dominante. Una de: "enojo", "frustracion", "satisfaccion", "gratitud", "confusion", "indiferencia", "tristeza", "preocupacion", "burla" (sarcasmo/mofa), "exigencia" (reclamo o demanda de acción)
- tema: el tema principal de tránsito. Uno de: "operativos", "multas", "licencias", "motos en banqueta", "corrupcion", "trafico", "transporte publico", "educacion vial", "semaforos", "parqueo", "accidentes", "infraestructura", "atencion ciudadana", "otro"
- intensidad: qué tan fuerte es la emoción, del 1 (muy leve) al 5 (muy intenso)
- resumen: máximo 10 palabras que capturen el dolor o elogio principal del comentario
- dolor: el problema concreto en pocas palabras (ej: "motos en banqueta", "multas injustas"), o null si no menciona ninguno
- postura: "aliado" (apoya a EMETRA/PMT), "critico" (en contra), o "neutral"
- zona: la zona que menciona (ej: "Zona 1", "Zona 11"), o null
- direccion: lugar o dirección exacta que menciona (ej: "Hospital Roosevelt", "El Trébol"), o null
- senalado: a quién dirige la queja (ej: "EMETRA", "PMT", "Héctor Flores", "ventas informales"), o null

Reglas de criterio:
- Una petición como "por favor vengan a la zona 1" o "para cuándo en zona 4" es un ciudadano que APOYA y pide más (postura aliado, emocion exigencia, sentimiento neutro o positivo).
- El sarcasmo como "solo cuando hay cámaras 🤣" es crítica (negativo, emocion burla, postura critico).
- "Felicito", "buen trabajo", "gracias" → positivo, emocion gratitud o satisfaccion.
- Lee el comentario completo antes de decidir; no te quedes con una palabra suelta.

Comentarios:
${lista}

Responde SOLO con un arreglo JSON válido, sin texto adicional ni markdown. Formato exacto:
[{"sentimiento":"...","emocion":"...","tema":"...","intensidad":3,"resumen":"...","dolor":"..." o null,"postura":"...","zona":"..." o null,"direccion":"..." o null,"senalado":"..." o null}, ...]
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
        const limpiar = (v) => v && v !== 'null' ? String(v).slice(0, 100) : null;
        const EMOCIONES = ['enojo','frustracion','satisfaccion','gratitud','confusion','indiferencia','tristeza','preocupacion','burla','exigencia'];
        const TEMAS = ['operativos','multas','licencias','motos en banqueta','corrupcion','trafico','transporte publico','educacion vial','semaforos','parqueo','accidentes','infraestructura','atencion ciudadana','otro'];
        let inten = parseInt(c.intensidad); if (isNaN(inten) || inten < 1 || inten > 5) inten = 3;
        resultados.push({
          sentimiento: ['positivo', 'negativo', 'neutro'].includes(c.sentimiento) ? c.sentimiento : 'neutro',
          confianza: 0.9,
          emocion: EMOCIONES.includes(c.emocion) ? c.emocion : 'indiferencia',
          tema: TEMAS.includes(c.tema) ? c.tema : 'otro',
          intensidad: inten,
          resumen: limpiar(c.resumen),
          dolor: limpiar(c.dolor),
          postura: ['aliado', 'critico', 'neutral'].includes(c.postura) ? c.postura : 'neutral',
          zona: limpiar(c.zona),
          direccion: limpiar(c.direccion),
          senalado: limpiar(c.senalado),
        });
      }
    } catch (e) {
      // si un lote falla, marca esos como neutros para no perder el flujo
      console.error('Error clasificando lote con IA:', e.message);
      for (let j = 0; j < grupo.length; j++) {
        resultados.push({ sentimiento: 'neutro', confianza: 0.3, emocion: 'indiferencia', tema: 'otro', intensidad: 3, resumen: null, dolor: null, postura: 'neutral', zona: null, direccion: null, senalado: null });
      }
    }
  }
  return resultados;
}
