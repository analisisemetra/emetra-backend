# EMETRA SENTINELA — Backend (Paso 1)

Este es el "cerebro" que guarda todo de forma permanente: usuarios, contraseñas
cifradas, entidades, proyectos y el registro de auditoría. Reemplaza la lógica
que antes vivía solo en el navegador del demo.

---

## Qué hace este backend

- **Login real**: las contraseñas se guardan cifradas (nadie puede leerlas, ni
  siquiera quien tenga acceso a la base de datos) y al entrar se entrega un
  "token" de sesión seguro.
- **Usuarios**: crear, listar y eliminar (solo el Administrador Total).
- **Entidades**: agregar y quitar las figuras/instituciones a monitorear.
- **Proyectos**: agregar y quitar proyectos con su aceptación.
- **Auditoría**: queda registrado quién hizo cada cosa.

Todo sobrevive al recargar y puede ser usado por varias personas a la vez.

---

## Lo que necesitas instalar (una sola vez)

1. **Node.js** (versión 18 o más nueva) → https://nodejs.org (botón "LTS").
2. **PostgreSQL** (la base de datos) → https://www.postgresql.org/download/
   Durante la instalación te pedirá una contraseña para el usuario "postgres".
   Anótala, la vas a necesitar.

Para verificar que quedaron instalados, abre una terminal y escribe:

    node --version
    psql --version

Si ambos responden con un número de versión, estás listo.

---

## Puesta en marcha (paso a paso)

### 1. Crear la base de datos

Abre la terminal de PostgreSQL (en Windows se llama "SQL Shell (psql)") y pega:

    CREATE DATABASE emetra_sentinela;
    CREATE USER emetra WITH PASSWORD 'emetra_local';
    GRANT ALL PRIVILEGES ON DATABASE emetra_sentinela TO emetra;

(Si usas otra contraseña, recuérdala para el paso 3.)

### 2. Instalar el proyecto

En la terminal, dentro de la carpeta `emetra-backend`:

    npm install

Esto descarga las piezas que el backend necesita. Tarda un minuto.

### 3. Configurar las claves

Copia el archivo `.env.example` y renómbralo a `.env`. Ábrelo y revisa:

- `DATABASE_URL`: si usaste la contraseña del paso 1 tal cual, déjalo igual.
  Si la cambiaste, ajústala aquí.
- `JWT_SECRET`: cámbialo por una cadena larga y aleatoria (mientras más rara, mejor).

### 4. Crear las tablas y cargar los datos iniciales

    npm run init-db

Verás mensajes confirmando que se cargaron los 4 usuarios, 3 entidades y 3
proyectos (los mismos del demo). Esto se hace una sola vez.

### 5. Encender el servidor

    npm start

Si todo salió bien verás:

    ✓ EMETRA SENTINELA backend corriendo en http://localhost:4000

Para comprobarlo, abre en el navegador:
http://localhost:4000/api/health
Debe responder con un mensaje que dice `"ok": true`.

---

## Usuarios de prueba (los mismos del demo)

| Usuario      | Contraseña   | Rol                |
|--------------|--------------|--------------------|
| admin        | emetra2026   | Administrador Total|
| supervisor   | pmt123       | Supervisor         |
| analista     | vial456      | Analista           |
| lectura      | solo789      | Solo Lectura       |

> En producción cambia estas contraseñas. Estas son solo para empezar.

---

## Cómo se conecta con la pantalla (el demo HTML)

Ahora mismo el demo (`voz-ciudadana.html`) tiene los datos "quemados" dentro.
El **Paso 2** será conectarlo a este backend: en vez de validar el login contra
una lista interna, le preguntará a `http://localhost:4000/api/login`, y lo mismo
para usuarios, entidades y proyectos.

Cuando confirmes que este backend arranca bien en tu máquina, hacemos el Paso 2:
modifico el HTML para que hable con el servidor. Después viene el Paso 3 (datos
reales de redes) y el Paso 4 (publicarlo en internet con un link).

---

## ¿Algo no funcionó?

- **"psql no se reconoce"**: PostgreSQL no quedó en el PATH; reinstala marcando
  la opción de agregar al PATH, o búscalo en "SQL Shell (psql)".
- **Error de conexión al correr `init-db`**: revisa que la contraseña en `.env`
  coincida con la que pusiste al crear el usuario `emetra`.
- **El puerto 4000 está ocupado**: cambia `PORT` en el `.env` a otro número (ej. 4100).
