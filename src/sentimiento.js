// ─── Clasificador de sentimiento (español, contexto tránsito Guatemala) ───
// Hace la primera clasificación automática. A cada comentario le asigna:
//   sentimiento: 'positivo' | 'negativo' | 'neutro'
//   confianza: 0 a 1  (bajo = dudoso → lo revisa una persona)
//
// Es un clasificador por léxico: rápido, gratis y sin depender de internet.
// En el futuro se puede reemplazar por un modelo de IA más potente sin tocar
// el resto del sistema (misma entrada y salida).

const POSITIVAS = [
  'felicito','felicidades','excelente','bien','buen','bueno','buena','gracias','apoyo',
  'necesario','necesarios','necesaria','adelante','correcto','mejor','mejora','ordenado',
  'seguridad','seguro','respeto','respetar','justo','eficiente','rápido','limpio','ayuda',
  'ayudaron','salvaron','auxilio','genial','perfecto','bravo','grande','admirable','orgullo'
];
const NEGATIVAS = [
  'nada','corrupto','corruptos','corrupción','multa','multas','ridículo','ridiculos','pésimo',
  'malo','mala','peor','horrible','vergüenza','ladrones','robo','roban','coima','mordida',
  'prepotente','prepotentes','abuso','abusan','inútil','inútiles','mediocre','mierda','asco',
  'piratas','ilegal','ilegales','incapaz','incapaces','no hacen','no sirven','solo quieren',
  'lentos','tráfico','cola','colas','desastre','caos','molesto','molesta','fastidio','retenes',
  'sin licencia','contra vía','imprudente','imprudentes','no respetan','impuestos','cobrar'
];
const NEGADORES = ['no','nunca','jamás','tampoco','ni'];

// Zonas de Ciudad de Guatemala mencionadas con frecuencia
const ZONAS = ['zona 1','zona 5','zona 6','zona 7','zona 9','zona 10','zona 11','zona 12',
  'zona 13','zona 17','zona 18','trébol','trebol','roosevelt','atanasio','aguilar batres',
  'periférico','periferico','kaminal','reforma','próceres','proceres','liberación','liberacion',
  'plaza españa','plaza espana','viaducto','san martín','san martin'];

function normaliza(t) {
  return (t || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita TODOS los acentos
    .replace(/[¡!¿?.,;:()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Quita acentos (para comparar de forma consistente con el texto normalizado)
function sinAcento(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function clasificarSentimiento(texto) {
  const t = normaliza(texto);
  if (!t || t.length < 3) return { sentimiento: 'neutro', confianza: 0.4 };

  const palabras = t.split(' ');
  let pos = 0, neg = 0;

  // Frases de varias palabras — comparadas sin acento
  for (const f of NEGATIVAS) {
    if (f.includes(' ') && t.includes(sinAcento(f))) neg += 1.5;
  }
  for (const f of POSITIVAS) {
    if (f.includes(' ') && t.includes(sinAcento(f))) pos += 1.5;
  }

  // Palabras sueltas (sin acento), con manejo de negadores ("no sirve" invierte)
  const POS_SET = new Set(POSITIVAS.filter(w => !w.includes(' ')).map(sinAcento));
  const NEG_SET = new Set(NEGATIVAS.filter(w => !w.includes(' ')).map(sinAcento));
  const NEG_DORES = NEGADORES.map(sinAcento);
  for (let i = 0; i < palabras.length; i++) {
    const w = palabras[i];
    const negada = i > 0 && NEG_DORES.includes(palabras[i - 1]);
    if (POS_SET.has(w)) negada ? neg++ : pos++;
    if (NEG_SET.has(w)) negada ? pos += 0.5 : neg++;
  }

  let sentimiento, confianza;
  const total = pos + neg;
  if (total === 0) {
    sentimiento = 'neutro';
    confianza = 0.5; // sin señales claras → dudoso, conviene revisar
  } else if (pos > neg) {
    sentimiento = 'positivo';
    confianza = Math.min(0.95, 0.55 + (pos - neg) / (total + 1));
  } else if (neg > pos) {
    sentimiento = 'negativo';
    confianza = Math.min(0.95, 0.55 + (neg - pos) / (total + 1));
  } else {
    sentimiento = 'neutro';
    confianza = 0.45; // empate → dudoso
  }
  return { sentimiento, confianza: Number(confianza.toFixed(2)) };
}

export function detectarZona(texto) {
  const t = normaliza(texto);
  for (const z of ZONAS) {
    if (t.includes(sinAcento(z))) {
      if (z.includes('zona')) {
        const num = z.match(/\d+/);
        return num ? 'Zona ' + num[0] : 'Zona';
      }
      return z.charAt(0).toUpperCase() + z.slice(1);
    }
  }
  return null;
}

// Umbral bajo el cual un comentario se marca como "dudoso" para revisión humana
export const UMBRAL_DUDOSO = 0.6;

// ─── Detección de "dolores" (temas de queja) en el texto ───
// Cada dolor tiene un nombre canónico y las variantes que lo activan.
const DOLORES = [
  { nombre: 'Motos en banqueta',      claves: ['moto en banqueta','motos en banqueta','moto en la banqueta','motos en la banqueta','motociclistas en banqueta','moto en acera','motos en acera','banqueta'] },
  { nombre: 'Multas injustas',        claves: ['multa injusta','multas injustas','multa abusiva','me multaron','poner multas','solo multan','multa','multas'] },
  { nombre: 'Cepos / inmovilizadores',claves: ['cepo','cepos','inmovilizador','engrilletado','garra','araña'] },
  { nombre: 'Congestión / tráfico',   claves: ['trafico','tráfico','congestion','congestión','embotellamiento','tranque','parqueo en la calle','no avanza'] },
  { nombre: 'Transporte público',     claves: ['transmetro','transurbano','bus rojo','buses rojos','transporte publico','transporte público','camioneta','parada de bus'] },
  { nombre: 'Buses / pilotos',        claves: ['piloto de bus','pilotos de bus','bus parado','buses parados','pirata','piratas','bus mal'] },
  { nombre: 'Semáforos',              claves: ['semaforo','semáforo','semaforos','semáforos','luz roja','no sirve el semaforo'] },
  { nombre: 'Señalización',           claves: ['senalizacion','señalización','no hay senales','sin señales','falta senalizacion'] },
  { nombre: 'Corrupción / mordida',   claves: ['mordida','coima','soborno','corrupto','corrupcion','corrupción','coima'] },
  { nombre: 'Vehículos oficiales',    claves: ['vehiculo oficial','vehículo oficial','carro oficial','patrulla mal','ellos si pueden'] },
  { nombre: 'Falta de operativos',    claves: ['no hacen nada','donde estan','dónde están','nunca estan','falta operativo','no hay pmt','brillan por su ausencia'] },
  { nombre: 'Licencias',              claves: ['licencia','licencias','renovar licencia','emision de licencia','emisión de licencia'] },
  { nombre: 'Accidentes',             claves: ['accidente','choque','atropello','atropellaron','colision','colisión'] },
];

export function detectarDolor(texto) {
  const t = sinAcento(normaliza(texto));
  for (const d of DOLORES) {
    for (const clave of d.claves) {
      if (t.includes(sinAcento(clave))) return d.nombre;
    }
  }
  return null;
}
