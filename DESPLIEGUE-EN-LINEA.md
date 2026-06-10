# Poner EMETRA SENTINELA en línea (para que otros entren con su link)

Esta guía sube el backend + la base de datos a internet usando **Railway**, y
la pantalla a **Netlify**. Resultado: un link al que cualquier persona que tú
registres puede entrar con su usuario y contraseña, desde cualquier dispositivo.

> No necesitas instalar nada en tu computadora ni dejarla encendida.
> Todo vive en internet 24/7.

Tiempo estimado: 30–45 minutos la primera vez.
Costo: gratis al inicio (Railway da crédito mensual); luego ~5 USD/mes.

---

## PARTE A — Subir el backend y la base de datos (Railway)

### 1. Crear cuenta
Entra a https://railway.app y regístrate (lo más fácil es con tu cuenta de GitHub;
si no tienes GitHub, créala en https://github.com — es gratis y la necesitarás).

### 2. Subir el código a GitHub
Railway lee el código desde GitHub. Tienes dos formas:

**Opción fácil (sin terminal):**
- En GitHub, crea un repositorio nuevo llamado `emetra-backend`.
- Usa el botón "uploading an existing file" y arrastra TODO el contenido de la
  carpeta `emetra-backend` (las carpetas `src`, y los archivos package.json,
  railway.json, etc.). NO subas la carpeta `node_modules` ni el archivo `.env`.

**Opción con terminal (si te animas):**
    cd emetra-backend
    git init
    git add .
    git commit -m "Backend EMETRA SENTINELA"
    git branch -M main
    git remote add origin https://github.com/TU_USUARIO/emetra-backend.git
    git push -u origin main

### 3. Crear el proyecto en Railway
- En Railway: "New Project" → "Deploy from GitHub repo" → elige `emetra-backend`.
- Railway detecta Node.js solo y empieza a construirlo.

### 4. Agregar la base de datos
- Dentro del proyecto: "New" → "Database" → "Add PostgreSQL".
- Railway crea la base y genera automáticamente una variable llamada
  `DATABASE_URL`. El backend ya está programado para usarla.

### 5. Configurar las variables de entorno
En tu servicio backend → pestaña "Variables", agrega:

    JWT_SECRET = (una cadena larga y aleatoria, inventa 30+ caracteres)
    JWT_EXPIRES_HORAS = 12
    NODE_ENV = production
    CORS_ORIGIN = *

(La `DATABASE_URL` ya está puesta por Railway, no la toques. `CORS_ORIGIN` lo
ajustaremos al final cuando tengas el link de la pantalla.)

### 6. Generar el link público
- Servicio backend → "Settings" → "Networking" → "Generate Domain".
- Te dará algo como `https://emetra-backend-production.up.railway.app`.
- Pruébalo: abre `ESE-LINK/api/health`. Debe decir `"ok": true`.

✅ Si ves eso, tu backend y base de datos ya están vivos en internet.
Las tablas y los 4 usuarios/3 entidades/3 proyectos se crearon solos al arrancar.

---

## PARTE B — Subir la pantalla (Netlify)

> Nota: la pantalla actual (`voz-ciudadana.html`) todavía tiene los datos del demo
> internos. En el **Paso siguiente** la conecto a tu backend de Railway para que
> el login y las listas usen la base real. Por ahora deja lista la cuenta:

- Entra a https://netlify.com y regístrate (también con GitHub).
- Arrastra el archivo `voz-ciudadana.html` a la zona de "deploy".
- Te dará un link tipo `https://emetra-sentinela.netlify.app`.

---

## PARTE C — Conectar pantalla con backend (lo hacemos juntos)

Cuando tengas:
1. El link del backend de Railway (`.../api/health` responde ok)
2. El link de la pantalla de Netlify

…me los pasas y hago el **Paso 2**: modificar el HTML para que hable con tu
backend real. Luego vuelves a subir el HTML actualizado a Netlify, y ajustamos
`CORS_ORIGIN` en Railway para que apunte a tu dominio de Netlify (más seguro
que dejarlo en `*`).

---

## Resumen de costos

| Servicio | Para qué | Costo |
|----------|----------|-------|
| Railway  | Backend + base de datos | Gratis al inicio, luego ~5 USD/mes |
| Netlify  | La pantalla | Gratis |
| GitHub   | Guardar el código | Gratis |

---

## Seguridad: antes de usarlo de verdad

1. **Cambia las contraseñas demo** (admin/emetra2026, etc.). Entra como admin y
   crea usuarios nuevos con contraseñas fuertes, luego elimina los de prueba.
2. **Pon un JWT_SECRET largo y único** (paso A5).
3. **Restringe CORS** al dominio de tu pantalla (parte C).

---

## ¿Se traba algo?

- **El build falla en Railway**: revisa que subiste package.json y la carpeta src,
  y que NO subiste node_modules.
- **/api/health no responde**: mira los "Logs" o "Deployments" en Railway; ahí
  aparece el error exacto.
- **Error de base de datos**: confirma que agregaste el PostgreSQL (paso A4) y que
  la variable DATABASE_URL existe en el servicio.
