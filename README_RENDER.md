# LEX TEST · Abogacía en Render

Aplicación rápida para preparar el examen de acceso a la abogacía:

- Importa PDF oficial con respuestas en rojo.
- Extrae preguntas de parte general y administrativo/contencioso-administrativo.
- Biblioteca local de exámenes guardados en el navegador.
- Test por examen concreto, por parte general, por administrativo o mixto.
- Modo aleatorio que mezcla preguntas de todos los exámenes guardados.
- Banco de falladas acumulado para repetir errores; cuando aciertas una pregunta fallada, sale del banco.
- Test pregunta a pregunta con contador y botón de pausa.
- Resumen final de aciertos, fallos y sin responder.
- Pantalla de soluciones para comprobar qué respuesta ha leído la app como correcta en cada examen.
- Explicación con IA si configuras `OPENAI_API_KEY`.
- Funciona online: la persona usuaria no instala Python.

---

## 1. Prueba local opcional

En tu ordenador, dentro de la carpeta del proyecto:

```bat
python -m pip install -r requirements.txt
uvicorn main:app --reload
```

Abre:

```text
http://127.0.0.1:8000
```

Comprueba servidor:

```text
http://127.0.0.1:8000/api/health
```

---

## 2. Subirlo a GitHub

1. Entra en https://github.com
2. Crea un repositorio nuevo, por ejemplo:

```text
abogacia-test
```

3. Sube todos estos archivos al repositorio:

```text
main.py
requirements.txt
render.yaml
.gitignore
static/index.html
static/styles.css
static/app.js
README_RENDER.md
```

La forma más sencilla si no quieres usar comandos:

- Botón **Add file**.
- **Upload files**.
- Arrastra toda la carpeta.
- **Commit changes**.

---

## 3. Crear la web en Render

1. Entra en https://render.com
2. Crea cuenta o inicia sesión.
3. Pulsa **New +**.
4. Elige **Web Service**.
5. Conecta tu GitHub.
6. Selecciona el repositorio `abogacia-test`.
7. Configura:

```text
Name: abogacia-test
Language: Python 3
Branch: main
Region: Frankfurt si aparece; si no, cualquiera
Plan: Free
Build Command: pip install -r requirements.txt
Start Command: uvicorn main:app --host 0.0.0.0 --port $PORT
```

8. Pulsa **Create Web Service**.

Render construirá la app y te dará una URL parecida a:

```text
https://abogacia-test.onrender.com
```

---

## 4. Activar IA de explicaciones

La IA es opcional. Sin clave, la app funciona igual, pero no explicará los fallos.

En Render:

1. Entra en tu servicio `abogacia-test`.
2. Ve a **Environment**.
3. Añade:

```text
OPENAI_API_KEY = tu_clave_de_openai
OPENAI_MODEL = gpt-4.1-mini
```

4. Pulsa **Save Changes**.
5. Render redeployará automáticamente.

Comprueba:

```text
https://TU_URL_DE_RENDER/api/health
```

Debe aparecer:

```json
"openai_configured": true
```

---

## 5. Usar la app

1. Entra en la URL de Render.
2. Sube el PDF oficial.
3. Pulsa **Analizar y guardar**.
4. Puedes pulsar **Ver soluciones** en cualquier examen guardado para comprobar las respuestas detectadas.
5. Elige bloque:
   - Parte general: 120 minutos.
   - Administrativo: 60 minutos.
   - General + Administrativo: 180 minutos.
   - Repetir falladas.
6. Pulsa **Comenzar test**.
7. Responde pregunta a pregunta. Puedes pausar el contador con **Pausar tiempo**.
8. Al finalizar verás resumen y corrección.

---

## 6. Excel opcional

También puedes importar un Excel `.xlsx` con estas columnas en la primera fila:

```text
pregunta | a | b | c | d | correcta | area | reserva
```

Ejemplo:

```text
correcta: a, b, c o d
area: general o administrativo
reserva: sí/no
```

---

## 7. Aviso sobre Render gratis

En el plan gratuito, Render puede dormir la app cuando está un rato sin uso. Al entrar de nuevo, puede tardar cerca de un minuto en despertar. Esto es normal en el plan Free.


---

## 7. Biblioteca local y falladas

La app guarda los exámenes en el navegador con `localStorage`. Esto significa:

- Si subes un PDF, queda guardado en ese ordenador y navegador.
- Puedes tener varios exámenes guardados y elegir cuál practicar.
- El modo aleatorio puede mezclar preguntas de todos los exámenes guardados.
- Las falladas se guardan automáticamente. Si vuelves a acertar una pregunta que estaba en falladas, se elimina de ese banco.
- Si cambias de ordenador o navegador, tendrás que volver a subir los PDFs, salvo que en el futuro se conecte a MySQL u otra base de datos.

No se guardan PDFs completos en Render: se guardan las preguntas extraídas en el navegador.


## Activar IA gratis con Gemini

1. Entra en Google AI Studio y crea una API key.
2. En Render > Environment añade:

```text
GEMINI_API_KEY = tu_clave_de_gemini
GEMINI_MODEL = gemini-2.5-flash-lite
```

3. Mantén también:

```text
PYTHON_VERSION = 3.11.9
```

4. Haz `Manual Deploy > Clear build cache & deploy`.

La app prioriza Gemini si existe `GEMINI_API_KEY`. Si no existe, intenta usar OpenAI con `OPENAI_API_KEY`.


## 8. Comprobar soluciones leídas del PDF

En cada tarjeta de examen guardado aparece el botón **Ver soluciones**. Esa pantalla muestra:

- Pregunta, número y bloque.
- Respuesta correcta detectada desde el rojo del PDF.
- Todas las opciones, marcando en azul la correcta.
- Filtro por general, administrativo, reservas o preguntas dudosas.
- Botón para imprimir o guardar el listado como PDF desde el navegador.

Si una pregunta aparece como **Revisar**, no entra en el test normal hasta que se compruebe manualmente.
