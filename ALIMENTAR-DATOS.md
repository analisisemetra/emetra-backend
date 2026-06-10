# Cómo alimentar el panel con datos reales

El panel se alimenta de **menciones**: los comentarios reales de redes sociales.
Configuramos el camino más simple: subes tu archivo de ExportComments y el
sistema hace el resto.

---

## El flujo, paso a paso

### 1. Exportas los comentarios (como ya lo haces)
En ExportComments, exporta los comentarios del post o página que quieras
monitorear. Te baja un archivo `.xlsx`. No tienes que limpiarlo ni ordenarlo:
el sistema entiende el formato de ExportComments tal cual viene.

### 2. Subes el archivo al panel
En la pestaña **"Cargar datos"** (la nueva), eliges el `.xlsx` y lo subes.

### 3. La IA clasifica automáticamente
Al recibir el archivo, el sistema lee cada comentario y le asigna un sentimiento:
**positivo, negativo o neutro**, junto con un nivel de confianza. También detecta
la zona si el comentario la menciona (ej: "en el Trébol", "zona 9").

### 4. Tú revisas solo los dudosos
Los comentarios que la IA no pudo clasificar con seguridad quedan marcados como
**"por revisar"**. En la misma pestaña aparece la lista; con un clic les asignas
el sentimiento correcto. Los claros no necesitan que toques nada.

### 5. Se acumula el histórico
Cada carga queda guardada con su fecha. Así, semana a semana, las gráficas de
tendencia van creciendo y puedes ver cómo evoluciona el ánimo de la gente con
el tiempo. Nunca se borra lo anterior; se suma.

---

## Qué columnas usa del archivo

El sistema busca automáticamente estas columnas de ExportComments:

| Columna en el .xlsx | Para qué se usa |
|---------------------|-----------------|
| Comment             | El texto del comentario (obligatoria) |
| Name                | Quién comentó |
| Date                | Cuándo (para las tendencias) |
| Likes               | Popularidad del comentario |
| Comment Permalink   | Enlace al comentario original |

Si tu archivo no tiene alguna, no pasa nada: el sistema usa las que encuentre.
Lo único imprescindible es la columna **Comment**.

---

## Sobre la clasificación automática

El clasificador entiende el español de Guatemala y el contexto de tránsito:
reconoce expresiones como "no hacen nada", "puro show", "los felicito",
"necesarios", nombres de zonas, etc. Acierta muy bien en los comentarios con
opinión clara y te deja para revisión los ambiguos.

Con el tiempo, si quieres más precisión, este clasificador se puede reemplazar
por un modelo de IA más avanzado **sin cambiar nada más** del sistema: el panel
y la base de datos siguen igual.

---

## Cuándo subir archivos

No hay regla fija. Lo común es **una vez por semana**, o después de una
publicación importante o un evento (un operativo grande, una crisis, etc.).
Mientras más seguido subas, más fina queda la línea de tendencia.

---

## Más adelante: automatizar (opcional)

Cuando el proyecto esté consolidado, se puede conectar la **API oficial de Meta**
para que los comentarios entren solos, sin subir archivos. Requiere una app
verificada por Meta. Por ahora, subir el `.xlsx` es más que suficiente y no
depende de trámites.
