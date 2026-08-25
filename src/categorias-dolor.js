// ─── Categorías de dolor — única fuente de verdad ───
// Antes esta lista vivía repetida (con pequeñas diferencias) en 3 funciones
// distintas de server.js: agruparDolores(), agruparSentTema(), y el MAPA de
// /api/dolor-comentarios. Cuando se agregaba una palabra clave en un lugar
// y se olvidaba en otro, los nombres dejaban de coincidir entre la nube de
// burbujas y "sentimiento por tema", y al hacer clic en una burbuja no
// aparecían todos los comentarios que sí contaba esa burbuja.
// Ahora las 3 funciones se alimentan de esta única lista — un solo lugar
// para agregar o ajustar categorías.

export const CATEGORIAS_DOLOR = [
  ['Motos en banqueta', ['banqueta', 'acera', 'moto en la', 'motos en la', 'motociclistas en']],
  ['Multas injustas / abusivas', ['multa injusta', 'multas injusta', 'multa abusiva', 'multas abusiva', 'multas excesiva', 'multa excesiva', 'excesiva', 'extorsion', 'solo multa', 'solo cobr', 'recaudacion', 'multas falsas', 'multa falsa', 'multas fantasma', 'fantasma', 'falsa']],
  ['Corrupción / mordida', ['corrupc', 'corrupto', 'mordida', 'coima', 'soborno', 'malversacion', 'enriquecimiento']],
  ['Falta de operativos', ['falta de operativo', 'operativos insuficiente', 'insuficiente', 'no hacen nada', 'no hay operativo', 'inaccion', 'falta de accion', 'no estan', 'donde estan']],
  ['Cepos / inmovilizadores', ['cepo', 'inmovilizador', 'garra', 'arana']],
  ['Congestión / tráfico', ['trafico', 'congestion', 'tranque', 'embotellamiento', 'no avanza', 'caos vial', 'caos vehicular', 'caos']],
  ['Transporte público', ['transporte publico', 'transmetro', 'transurbano', 'bus rojo', 'buses rojo', 'camioneta', 'pilotos de bus', 'piloto de bus', 'piloto']],
  ['Taxis / transporte pirata', ['taxi pirata', 'taxis pirata', 'pirata']],
  ['Licencias', ['licencia']],
  ['Educación vial', ['educacion vial', 'cultura vial']],
  ['Semáforos / señalización', ['semaforo', 'senalizacion', 'senales', 'senal vial', 'senal']],
  ['Vehículos / vendedores que apartan parqueo', ['apartan parqueo', 'aparta parqueo', 'apartaparqueo', 'aparta-parqueo', 'estacionamiento irregular', 'mal parqueo', 'parqueo informal', 'ocupan parqueo']],
  ['Ventas / obstáculos en vía pública', ['venta informal', 'ventas informal', 'venta de licencia', 'vendedores', 'obstaculo', 'obstaculos', 'via publica ocupada', 'apartadores']],
  ['Doble moral / vehículos oficiales', ['doble moral', 'vehiculo oficial', 'vehiculos oficiale', 'doble estandar', 'ellos si pueden', 'favoritismo', 'arrogancia']],
  ['Infraestructura vial', ['infraestructura', 'baches', 'calles en mal estado', 'mal estado de calle', 'carreteras en mal', 'sin reparacion', 'mantenimiento vial', 'mal estado', 'carreteras', 'mantenimiento']],
  ['Accidentes / seguridad vial', ['accidente', 'choque', 'atropell', 'muerte', 'muertos', 'conductores ebrios', 'alcohol al volante', 'ebrio', 'alcohol']],
];

// Normaliza texto (sin acentos, minúsculas) para comparar contra las claves
export function normDolor(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Encuentra la categoría canónica de un texto de dolor, o null si no coincide con ninguna
export function categoriaDe(textoDolor) {
  const t = normDolor(textoDolor);
  for (const [nombre, claves] of CATEGORIAS_DOLOR) {
    if (claves.some(k => t.includes(normDolor(k)))) return nombre;
  }
  return null;
}

// Devuelve { nombreCategoria: [claves...] } — útil para armar condiciones SQL (dolor-comentarios)
export function mapaCategorias() {
  const mapa = {};
  for (const [nombre, claves] of CATEGORIAS_DOLOR) mapa[nombre] = claves;
  return mapa;
}
