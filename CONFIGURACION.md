# 🔧 Guía de Configuración - UDEL Video Analyzer API

## 📋 Requisitos Previos

- Node.js >= 18.0.0
- Cuenta de Google Cloud con API de Gemini habilitada
- Proyecto de Firebase con Firestore
- (Opcional) Cuenta de Vimeo con API habilitada

## 🚀 Configuración Paso a Paso

### 1. Variables de Entorno

Crea un archivo `.env` en la carpeta `Api/` basándote en `.env.example`:

```bash
cp .env.example .env
```

### 2. Google Gemini API Key

1. Ve a [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Crea o selecciona un proyecto
3. Genera una nueva API key
4. Copia la key y pégala en `.env`:
   ```
   GEMINI_API_KEY=tu_api_key_real_aqui
   ```

**IMPORTANTE**: El sistema ahora usa automáticamente los modelos correctos:
- **Para análisis de video**: `gemini-1.5-pro-latest` (con soporte de video)
- **Para generación de texto**: `gemini-1.5-pro-latest` (para cartas descriptivas)

### 3. Firebase Service Account

1. Ve a [Firebase Console](https://console.firebase.google.com/)
2. Selecciona tu proyecto
3. Ve a **Project Settings** → **Service Accounts**
4. Haz clic en **Generate New Private Key**
5. Descarga el archivo JSON
6. Copia TODO el contenido del JSON en una sola línea y pégalo en `.env`:
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"tu-proyecto",...}
   ```

### 4. Vimeo API (Opcional)

Si quieres habilitar la subida automática a Vimeo:

1. Ve a [Vimeo Developer](https://developer.vimeo.com/apps)
2. Crea una nueva app o usa una existente
3. Genera un Access Token con permisos:
   - `upload`
   - `edit`
   - `video_files`
4. Copia el token y pégalo en `.env`:
   ```
   VIMEO_ACCESS_TOKEN=tu_vimeo_token_aqui
   ```

## 📦 Instalación de Dependencias

```bash
cd Api
npm install
```

## 🏃 Ejecutar el Servidor

### Desarrollo (con auto-reload)
```bash
npm run dev
```

### Producción
```bash
npm start
```

El servidor estará disponible en `http://localhost:10000`

## 🔍 Verificar Configuración

Visita `http://localhost:10000/health` para verificar que todo esté configurado correctamente.

Deberías ver una respuesta como:
```json
{
  "ok": true,
  "projectId": "tu-proyecto-firebase",
  "videoModel": "models/gemini-1.5-pro-latest",
  "textModel": "models/gemini-1.5-pro-latest",
  "vimeoConfigured": true,
  "scoreThreshold": 10
}
```

## 🐛 Solución de Problemas

### Error: "Modelo Gemini inválido"
- **Solución**: Ya no necesitas configurar `GEMINI_MODEL` manualmente. El sistema usa automáticamente los modelos correctos.

### Error: "GEMINI_API_KEY no configurada"
- **Solución**: Verifica que tu archivo `.env` tenga la variable `GEMINI_API_KEY` con una key válida.

### Error: "Firebase Admin no inicializado"
- **Solución**: Verifica que `FIREBASE_SERVICE_ACCOUNT_JSON` contenga un JSON válido en una sola línea.

### Error al analizar videos
- **Causa común**: Modelo deprecado o sin soporte de video
- **Solución**: La actualización ya usa `gemini-1.5-pro-latest` que soporta videos nativamente

### Error al generar cartas descriptivas
- **Causa común**: Modelo de visión usado para texto
- **Solución**: La actualización ya usa el modelo correcto para generación de texto

## 📊 Endpoints Disponibles

### `POST /analyzeVideo`
Analiza un video educativo y retorna métricas de calidad pedagógica.

### `POST /uploadToVimeo`
Sube un video aprobado a Vimeo (requiere score >= umbral).

### `POST /generateCartaDescriptiva`
Genera una carta descriptiva completa basada en una descripción del tema.

### `GET /health`
Verifica el estado del servidor y la configuración.

## 🔐 Seguridad

- **NUNCA** subas tu archivo `.env` a Git
- El archivo `.gitignore` ya está configurado para ignorar `.env`
- Usa variables de entorno en producción (Render, Heroku, etc.)

## 🚀 Deploy en Render

1. Conecta tu repositorio a Render
2. Configura las variables de entorno en el dashboard de Render
3. Render detectará automáticamente el `render.yaml` y configurará el servicio

## 📝 Notas Importantes

- El umbral de calidad para Vimeo está configurado en 10% (para pruebas)
- Puedes ajustar `SCORE_THRESHOLD` en `server.js` según tus necesidades
- Los videos se procesan de forma asíncrona usando Firestore para el estado
- El sistema incluye retry automático con modelos alternativos si uno falla

## 🆘 Soporte

Si encuentras problemas, verifica:
1. Los logs del servidor (`console.log` muestra información detallada)
2. El endpoint `/health` para verificar la configuración
3. Que tu API key de Gemini tenga cuota disponible
4. Que Firebase Firestore esté habilitado en tu proyecto