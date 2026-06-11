// ─── Análisis de amenazas: puntaje de hostilidad y patrones de coordinación ───
// Filosofía: TAJANTE AL MEDIR, HUMANO AL ACTUAR.
// El sistema mide y ordena sin rodeos, pero la etiqueta final de "ataque
// coordinado" y la decisión de actuar la pone siempre una persona.
import { pool } from './db.js';

// Normaliza texto para comparar (sin acentos, sin signos, minúsculas)
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9áéíóúñ ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Similitud entre dos textos (coeficiente de Jaccard sobre palabras)
function similitud(a, b) {
  const sa = new Set(norm(a).split(' ').filter(w => w.length > 2));
  const sb = new Set(norm(b).split(' ').filter(w => w.length > 2));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

// Identifica el "post" de una mención por su permalink (sin el fragmento del comentario)
function postDe(permalink) {
  if (!permalink) return null;
  // Quita el id del comentario, deja el del post
  return String(permalink).split('?')[0].replace(/\/comment.*$/, '').slice(0, 200);
}

// ─── Análisis principal ───
export async function analizarAmenazas() {
  // Trae todas las menciones con identidad
  const { rows: menciones } = await pool.query(`
    SELECT id, autor, username, profile_id, red, fecha, texto, sentimiento, permalink, followers
    FROM menciones
    WHERE profile_id IS NOT NULL AND profile_id <> ''
    ORDER BY fecha NULLS LAST`);

  if (menciones.length === 0) {
    return { cuentas: [], patrones: { sincronia: [], lenguaje: [], objetivo: [] }, resumen: vacio() };
  }

  // Agrupa por cuenta (profile_id)
  const cuentas = new Map();
  for (const m of menciones) {
    if (!cuentas.has(m.profile_id)) {
      cuentas.set(m.profile_id, {
        profile_id: m.profile_id, autor: m.autor, username: m.username, red: m.red,
        followers: m.followers, comentarios: [], negativos: 0, posts: new Set(),
      });
    }
    const c = cuentas.get(m.profile_id);
    c.comentarios.push(m);
    if (m.sentimiento === 'negativo') c.negativos++;
    const p = postDe(m.permalink); if (p) c.posts.add(p);
    if (m.followers != null) c.followers = m.followers;
  }

  // ── Detección de SINCRONÍA TEMPORAL ──
  // Pares de cuentas que comentaron el mismo post dentro de ~5 minutos
  const sincronia = [];
  const porPost = new Map();
  for (const m of menciones) {
    const p = postDe(m.permalink); if (!p || !m.fecha) continue;
    if (!porPost.has(p)) porPost.set(p, []);
    porPost.get(p).push(m);
  }
  const sincroniaCuenta = new Map(); // profile_id -> cuántas veces sincronizó
  for (const [post, lista] of porPost) {
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        if (lista[i].profile_id === lista[j].profile_id) continue;
        const dt = Math.abs(new Date(lista[i].fecha) - new Date(lista[j].fecha)) / 60000;
        if (dt <= 5 && lista[i].sentimiento === 'negativo' && lista[j].sentimiento === 'negativo') {
          sincronia.push({ post, a: lista[i].autor, b: lista[j].autor, minutos: Math.round(dt * 10) / 10 });
          sincroniaCuenta.set(lista[i].profile_id, (sincroniaCuenta.get(lista[i].profile_id) || 0) + 1);
          sincroniaCuenta.set(lista[j].profile_id, (sincroniaCuenta.get(lista[j].profile_id) || 0) + 1);
        }
      }
    }
  }

  // ── Detección de SIMILITUD DE LENGUAJE ──
  // Pares de cuentas distintas con texto casi idéntico
  const lenguaje = [];
  const lenguajeCuenta = new Map();
  const negs = menciones.filter(m => m.sentimiento === 'negativo' && norm(m.texto).length > 15);
  for (let i = 0; i < negs.length; i++) {
    for (let j = i + 1; j < negs.length; j++) {
      if (negs[i].profile_id === negs[j].profile_id) continue;
      const sim = similitud(negs[i].texto, negs[j].texto);
      if (sim >= 0.6) {
        lenguaje.push({ a: negs[i].autor, b: negs[j].autor, similitud: Math.round(sim * 100) });
        lenguajeCuenta.set(negs[i].profile_id, Math.max(lenguajeCuenta.get(negs[i].profile_id) || 0, sim));
        lenguajeCuenta.set(negs[j].profile_id, Math.max(lenguajeCuenta.get(negs[j].profile_id) || 0, sim));
      }
    }
  }

  // ── PUNTAJE DE HOSTILIDAD por cuenta (0-100) ──
  const maxNeg = Math.max(...[...cuentas.values()].map(c => c.negativos), 1);
  const listaCuentas = [];
  for (const c of cuentas.values()) {
    // 1. Volumen negativo (hasta 30)
    const pVolumen = Math.min(30, (c.negativos / maxNeg) * 30);
    // 2. Reincidencia: en cuántos posts distintos apareció (hasta 25)
    const pReincidencia = Math.min(25, (c.posts.size - 1) * 8);
    // 3. Sincronía temporal (hasta 20)
    const pSincronia = Math.min(20, (sincroniaCuenta.get(c.profile_id) || 0) * 7);
    // 4. Similitud de lenguaje (hasta 15)
    const pLenguaje = Math.min(15, (lenguajeCuenta.get(c.profile_id) || 0) * 15);
    // 5. Perfil sospechoso, solo X (hasta 10): pocos followers + muchos comentarios
    let pPerfil = 0;
    if (c.red === 'X' && c.followers != null) {
      if (c.followers < 100 && c.comentarios.length >= 3) pPerfil = 10;
      else if (c.followers < 500 && c.comentarios.length >= 3) pPerfil = 5;
    }
    const puntaje = Math.round(pVolumen + pReincidencia + pSincronia + pLenguaje + pPerfil);

    // Clasificación de postura general de la cuenta
    const totalCom = c.comentarios.length;
    const ratioNeg = c.negativos / totalCom;
    const positivos = c.comentarios.filter(m => m.sentimiento === 'positivo').length;
    let bando;
    if (ratioNeg >= 0.6 && c.negativos >= 2) bando = 'hostil';
    else if (positivos > c.negativos && positivos >= 2) bando = 'aliado';
    else bando = 'neutral';

    let nivel;
    if (puntaje >= 70) nivel = 'ALTA';
    else if (puntaje >= 40) nivel = 'SOSPECHOSA';
    else nivel = 'BAJA';

    // permalink de ejemplo para ubicar la cuenta
    const ejemplo = c.comentarios.find(m => m.permalink)?.permalink || null;

    listaCuentas.push({
      autor: c.autor, username: c.username, profile_id: c.profile_id, red: c.red,
      followers: c.followers, comentarios: totalCom, negativos: c.negativos,
      posts: c.posts.size, puntaje, nivel, bando, enlace: ejemplo,
      evidencia: {
        volumen: Math.round(pVolumen), reincidencia: Math.round(pReincidencia),
        sincronia: Math.round(pSincronia), lenguaje: Math.round(pLenguaje), perfil: pPerfil,
        sincronizaciones: sincroniaCuenta.get(c.profile_id) || 0,
        similitudMax: Math.round((lenguajeCuenta.get(c.profile_id) || 0) * 100),
      },
    });
  }

  // Ordena por hostilidad (la lista única que pidió el usuario)
  listaCuentas.sort((a, b) => b.puntaje - a.puntaje);

  // ── OBJETIVO COMÚN: posts más atacados por cuentas hostiles ──
  const hostilesIds = new Set(listaCuentas.filter(c => c.bando === 'hostil').map(c => c.profile_id));
  const objetivoMap = new Map();
  for (const m of menciones) {
    if (!hostilesIds.has(m.profile_id)) continue;
    const p = postDe(m.permalink); if (!p) continue;
    if (!objetivoMap.has(p)) objetivoMap.set(p, { post: p, ataques: 0, cuentas: new Set(), enlace: m.permalink });
    const o = objetivoMap.get(p); o.ataques++; o.cuentas.add(m.profile_id);
  }
  const objetivo = [...objetivoMap.values()]
    .map(o => ({ post: o.post, ataques: o.ataques, cuentas: o.cuentas.size, enlace: o.enlace }))
    .filter(o => o.cuentas > 1)
    .sort((a, b) => b.ataques - a.ataques).slice(0, 10);

  // Resumen
  const hostiles = listaCuentas.filter(c => c.bando === 'hostil');
  const aliados = listaCuentas.filter(c => c.bando === 'aliado');
  const resumen = {
    totalCuentas: listaCuentas.length,
    hostiles: hostiles.length,
    aliados: aliados.length,
    neutrales: listaCuentas.filter(c => c.bando === 'neutral').length,
    altaHostilidad: listaCuentas.filter(c => c.nivel === 'ALTA').length,
    paresSincronia: sincronia.length,
    paresLenguaje: lenguaje.length,
  };

  return {
    cuentas: listaCuentas,
    patrones: {
      sincronia: sincronia.slice(0, 30),
      lenguaje: lenguaje.slice(0, 30),
      objetivo,
    },
    resumen,
  };
}

function vacio() {
  return { totalCuentas: 0, hostiles: 0, aliados: 0, neutrales: 0, altaHostilidad: 0, paresSincronia: 0, paresLenguaje: 0 };
}
