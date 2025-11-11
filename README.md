# Servicio de Análisis de Videos con Gemini

Servicio desplegado en Render que analiza videos de clase usando Google Gemini AI según una rúbrica académica específica. **No almacena videos**, solo guarda el reporte de análisis en Firestore.

## 🎯 Características

- **Análisis automático** de videos con Gemini 1.5 Pro
- **Rúbrica académica** evaluando:
  - ✅ R1: Historia inicial (con timestamps)
  - ✅ R2: Máximo 3 bullets principales
  - ✅ R3: Tarea asignada al alumno
- **Sin almacenamiento** de videos (procesamiento en memoria)
- **Reportes en Firestore** con score, hallazgos y sugerencias
- **Arquitectura serverless** lista para Render

## 🏗️ Arquitectura

```
Cliente → POST /analyzeVideo → [Multer Memory] → Gemini API → Firestore
                                       ↓
                               (video se descarta)
```

## 🚀 Deployment en Render

### 1. Configuración Inicial

1. Clona este repositorio
2. Conecta tu repositorio a Render
3. Render detectará automáticamente `render.yaml`

### 2. Variables de Entorno

Configura estas variables en Render Dashboard:

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `GEMINI_API_KEY` | API Key de Google AI Studio | ✅ |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | JSON completo de credenciales Firebase | ✅ |
| `GEMINI_MODEL` | Modelo a usar (default: `models/gemini-1.5-pro`) | ❌ |
| `NODE_ENV` | Ambiente (default: `production`) | ❌ |

#### Obtener GEMINI_API_KEY:
1. Ve a [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Crea un nuevo API Key
3. Copia y guarda en Render

#### Obtener FIREBASE_SERVICE_ACCOUNT_JSON:
1. Ve a Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Descarga el archivo JSON
4. Copia **todo el contenido** del JSON como string en Render

### 3. Deploy

Una vez configuradas las variables:
```bash
git push origin main
```

Render automáticamente:
- Ejecuta `npm install`
- Inicia el servicio con `npm start`
- Expone el endpoint en tu URL de Render

## 📡 API Endpoints

### Health Check
```bash
GET /health
```

**Respuesta:**
```
ok
```

---

### Analizar Video
```bash
POST /analyzeVideo
Content-Type: multipart/form-data
```

**Parámetros:**
- `file`: Archivo de video (hasta 500 MB)
- `analysisId`: ID único para el documento en Firestore

**Ejemplo con curl:**
```bash
curl -X POST https://tu-servicio.onrender.com/analyzeVideo \
  -F "file=@clase.mp4" \
  -F "analysisId=video_12345"
```

**Ejemplo con JavaScript:**
```javascript
const formData = new FormData();
formData.append('file', videoFile);
formData.append('analysisId', 'video_12345');

const response = await fetch('https://tu-servicio.onrender.com/analyzeVideo', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log(result); // { ok: true, analysisId: "video_12345" }
```

**Respuesta exitosa:**
```json
{
  "ok": true,
  "analysisId": "video_12345"
}
```

## 📊 Estructura del Reporte en Firestore

Los reportes se guardan en `analyses/{analysisId}`:

```javascript
{
  status: "done",  // "processing" | "done" | "error"
  result: {
    score: 85,     // 0-100
    summary: "El video presenta una historia inicial efectiva...",
    findings: [
      {
        ruleId: "R1",
        ok: true,
        note: "Historia inicial entre 0:05-0:45, presenta contexto claro"
      },
      {
        ruleId: "R2",
        ok: true,
        note: "Identifica 3 bullets: concepto A, ejemplo B, aplicación C"
      },
      {
        ruleId: "R3",
        ok: false,
        note: "No se detectó tarea explícita. Sugerencia: crear ejercicio práctico"
      }
    ],
    suggestions: [
      "Agregar indicadores visuales en los bullets",
      "Incluir tarea específica al final del video"
    ]
  },
  updatedAt: Timestamp
}
```

## 🔧 Desarrollo Local

### Prerequisitos
- Node.js 18+
- npm
- Cuenta en Google AI Studio
- Proyecto en Firebase

### Instalación

```bash
# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Iniciar servidor
npm start
```

El servidor estará disponible en `http://localhost:3000`

## 🔒 Seguridad

- ✅ Videos procesados **solo en memoria** (multer.memoryStorage)
- ✅ Videos temporales en Gemini **se eliminan automáticamente**
- ✅ Límite de 500 MB por archivo
- ✅ Validación de tipo MIME (solo video/*)
- ⚠️ Configura CORS según tus necesidades en producción

## 📝 Notas Técnicas

### Flujo de Procesamiento

1. **Recepción**: Video se carga en memoria (no en disco)
2. **Upload temporal**: Se sube a Gemini API para análisis
3. **Análisis**: Gemini evalúa según rúbrica académica
4. **Limpieza**: Video se elimina de Gemini inmediatamente
5. **Persistencia**: Solo el reporte JSON se guarda en Firestore

### Límites y Timeouts

- **Tamaño máximo**: 500 MB por video
- **Timeout upload**: 10 minutos
- **Timeout análisis**: 8 minutos
- **Modelos soportados**: gemini-1.5-pro, gemini-1.5-flash

### Personalizar la Rúbrica

Edita la función `geminiAnalyze()` en `server.js:46-92` para modificar:
- Reglas de evaluación
- Ponderación del score
- Campos del JSON de respuesta
- Instrucciones del prompt

## 🐛 Troubleshooting

### Error: "GEMINI_API_KEY not set"
- Verifica que configuraste la variable de entorno en Render

### Error: "Firebase initialization failed"
- Verifica que `FIREBASE_SERVICE_ACCOUNT_JSON` contenga un JSON válido
- Asegúrate de copiar todo el contenido del archivo descargado

### Video no se procesa
- Verifica que el archivo sea video/* (mp4, mov, avi, etc.)
- Confirma que el tamaño sea menor a 500 MB
- Revisa los logs en Render Dashboard

### Timeout en análisis
- Videos muy largos pueden exceder el timeout de 8 minutos
- Considera usar gemini-1.5-flash para videos largos (más rápido)

## 📄 Licencia

MIT

## 🤝 Contribuciones

Pull requests son bienvenidos. Para cambios importantes, abre un issue primero.
