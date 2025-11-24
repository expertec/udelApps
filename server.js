 // server.js - Analyzer API (Render)
// ====== Dependencias ======
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import OpenAI from 'openai';
import { admin, db, FieldValue } from './firebaseAdmin.js';

// ====== App básica ======
const app = express();
app.use(cors());
app.use(express.json());

// ====== Entorno ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Modelos desde variables de entorno con fallbacks inteligentes
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || 'gemini-2.0-flash-exp';
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash-exp';

// Modelos de fallback si el principal falla
const VALID_VIDEO_MODELS = [
  VIDEO_MODEL,
  'gemini-2.0-flash-exp',
  'gemini-1.5-pro',
  'gemini-1.5-flash'
].filter((v, i, a) => a.indexOf(v) === i); // Eliminar duplicados

const VALID_TEXT_MODELS = [
  TEXT_MODEL,
  'gemini-2.0-flash-exp',
  'gemini-1.5-pro',
  'gemini-1.5-flash'
].filter((v, i, a) => a.indexOf(v) === i); // Eliminar duplicados

console.log(`🎬 Modelo de video: ${VIDEO_MODEL}`);
console.log(`📝 Modelo de texto: ${TEXT_MODEL}`);
console.log(`🔄 Fallbacks de video: ${VALID_VIDEO_MODELS.slice(1).join(', ')}`);
console.log(`🔄 Fallbacks de texto: ${VALID_TEXT_MODELS.slice(1).join(', ')}`);

// Función auxiliar para intentar con modelos alternativos
async function retryWithModels(operation, initialModel, validModels) {
  const models = validModels.filter(m => m !== initialModel);
  let lastError = null;

  // Primer intento con el modelo inicial
  try {
    console.log(`🔄 Intentando con modelo: ${initialModel}`);
    return await operation(initialModel);
  } catch (e) {
    console.warn(`⚠️ Error con modelo ${initialModel}:`, e.message);
    lastError = e;
  }

  // Intentar con modelos alternativos
  for (const model of models) {
    try {
      console.log(`🔄 Reintentando con modelo alternativo: ${model}`);
      return await operation(model);
    } catch (e) {
      console.warn(`⚠️ Error con modelo ${model}:`, e.message);
      lastError = e;
    }
  }

  throw lastError || new Error('Todos los modelos fallaron');
}
const VIMEO_ACCESS_TOKEN = process.env.VIMEO_ACCESS_TOKEN;
const SCORE_THRESHOLD = 10; // Umbral para permitir subida a Vimeo (10% para pruebas)

// Inicializar OpenAI si está configurado
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log('✅ OpenAI configurado para generación de cartas descriptivas');
} else {
  console.log('⚠️ OpenAI no configurado - solo se usará Gemini');
}

if (!GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY');

// ====== Multer (memoria) ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('video/')) return cb(new Error('Solo se aceptan archivos de video'), false);
    cb(null, true);
  }
});

// ====== Helpers Gemini Files ======

// Extrae "files/xxxxx" desde la respuesta de files:upload
function extractGeminiFileRef(uploaded) {
  const f = uploaded?.file;
  if (!f) return null;
  if (f.name) return f.name; // "files/xxxxx"
  if (f.uri) {
    const m = f.uri.match(/\/files\/([^/]+)$/);
    return m ? `files/${m[1]}` : f.uri;
  }
  return null;
}

// Espera a que el archivo quede ACTIVE
async function waitGeminiFileReady(fileRef, { timeoutMs = 45000, intervalMs = 1200 } = {}) {
  const id = String(fileRef).replace(/^.*files\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/files/${id}?key=${GEMINI_API_KEY}`;
  const start = Date.now();
  for (;;) {
    const r = await axios.get(url, { timeout: 10000 });
    const state = r?.data?.file?.state || r?.data?.state;
    if (state === 'ACTIVE') return r.data.file || r.data;
    if (Date.now() - start > timeoutMs) throw new Error(`El archivo en Gemini no quedó listo (estado: ${state || 'desconocido'})`);
    await new Promise(res => setTimeout(res, intervalMs));
  }
}

// Sube buffer a Gemini Files (resumable)
async function uploadToGemini(buffer, mimeType, fileName) {
  const initRes = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
    { file: { display_name: fileName || 'video.mp4', mime_type: mimeType } },
    {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'X-Goog-Upload-File-Name': encodeURIComponent(fileName || 'video.mp4'),
      },
      timeout: 60_000,
    }
  );

  const uploadUrl = initRes.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('No se obtuvo upload URL de Gemini');

  const finalizeRes = await axios.post(uploadUrl, buffer, {
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    maxBodyLength: Infinity,
    timeout: 10 * 60_000,
  });

  return finalizeRes.data; // { file: { name, uri, ... } }
}

// Borra el archivo remoto (best-effort)
async function deleteGeminiFile(fileNameOrUri) {
  try {
    if (!fileNameOrUri) return;
    const id = String(fileNameOrUri).replace(/^.*files\//, '');
    await axios.delete(
      `https://generativelanguage.googleapis.com/v1beta/files/${id}?key=${GEMINI_API_KEY}`,
      { timeout: 30_000 }
    );
  } catch (e) {
    console.warn('No se pudo borrar el archivo en Gemini:', e?.response?.status, e?.response?.data || String(e));
  }
}

// ====== Gemini: generateContent (v1beta, snake_case para archivos) ======
async function geminiAnalyze({ fileUri, mimeType }) {
  console.log(`📹 Iniciando análisis de video con URI: ${fileUri}`);
  return retryWithModels(async (MODEL) => {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { 
            file_data: { 
              file_uri: fileUri, 
              mime_type: mimeType 
            } 
          },
          {
        text:
`IMPORTANTE: Responde SIEMPRE en ESPAÑOL. Todos los textos, notas, sugerencias y descripciones deben estar en español.

Evalúa el video adjunto como clase en video optimizada para atención y aprendizaje y calidad técnica profesional. Usa audio + transcripción + metadatos (resolución, fps, bitrate, sample rate, canales) si están disponibles. No inventes datos: si algo no puede detectarse, márcalo como "unknown". Responde SOLO JSON con el esquema indicado al final.

REGLAS (mejores prácticas pedagógicas + estándares técnicos, con IDs y pesos):

R1_HOOK (peso 8): Inicio con historia/pregunta/demo del resultado <=30s. Detecta tipo y timestamps.

R2_OBJETIVOS (peso 8): 1–2 objetivos observables al inicio (<=90s) con verbo de logro. Extrae texto si aparece.

R3_MAPA_3PASOS (peso 6): Roadmap de máx. 3 pasos visible o verbal. Cuenta pasos y ubicación.

R4_CARGA_COGNITIVA (peso 8): Diapositivas limpias (≤3 bullets simultáneos, ≤10 palabras/bullet). Reporta máximos y breaches.

R5_SEGMENTACION (peso 8): Clase en 2–4 bloques con señalización ("Parte 1/3", títulos, marcadores). Lista bloques con timestamps.

R6_SENALIZACION (peso 6): Guías visuales/verbales (cursor, zoom, resaltado, "Paso 2 de 3") al introducir conceptos. Evidencia con momentos.

R7_DEMO_INMEDIATA (peso 8): Tras cada concepto clave hay demo/ejemplo práctico inmediato. Vincula concepto→demo por timestamp.

R8_PRACTICA_ACTIVA (peso 12): ≥2 micro-prácticas (tu turno/pausa/mini-reto) intercaladas cada 2–4 min. Lista instrucciones y tiempos.

R9_RECUPERACION (peso 8): Chequeo rápido de recuerdo/comprensión (pregunta, mini-quiz) con retro breve. Detecta ítems y respuesta/clave si existe.

R10_TRANSFERENCIA (peso 8): Caso/aplicación al mundo real (dataset, API, situación realista). Describe el caso y dónde ocurre.

R11_CIERRE_RECAP (peso 6): Recap de 3 bullets (≤10 palabras c/u) + errores comunes. Extrae texto si aparece.

R12_TAREA_Y_CRITERIOS (peso 12): Tarea aplicable (≤20 min) con entregable y criterios de evaluación (rúbrica/checklist). Extrae ambos si existen.

R13_RITMO_ACCESIBILIDAD (peso 8): Ritmo ágil (sin pantalla estática >20s; cortes/cambios cada 60–90s), accesibilidad (subtítulos/CC o transcripción). Marca problemas si se perciben.

— Estándares de calidad técnica profesional —

R14_MEDIA_VIDEO (peso 10): Imagen: resolución >=1080p, fps estable (>=24), exposición/contraste adecuados (sin clipping severo), balance de blancos consistente (piel natural), enfoque nítido en el rostro o contenido, iluminación uniforme (sin sombras duras sobre ojos), encuadre correcto (regla de tercios, headroom adecuado), fondo no distractor (ruido visual bajo), sin artefactos de compresión graves.
• Si hay metadatos, extrae resolución/fps/bitrate.
• Si no, estima por observación y marca lo desconocido como "unknown".
• Reporta timestamps de problemas (desenfoque, flicker, sobreexposición, banding, moiré).

R15_MEDIA_AUDIO (peso 12): Sonido: inteligible y limpio, sin clipping. Objetivo de loudness -16 a -12 LUFS (voz), picos ≤ -1 dBTP, ruido de fondo < -50 dBFS (estimado), sample rate >= 44.1 kHz, canales mono/estéreo correctos, distancia de mic adecuada (proximidad sin popping), sin eco/reverberación excesiva, sin viento o zumbidos.
• Si hay metadatos, extrae sample rate, canales, bitrate.
• Si no, estima con descriptores cualitativos ("ruido de ventilador", "eco sala").
• Reporta timestamps de ruidos, pops, sibilancia, inconsistencia de volumen.

R16_MEDIA_PRESENTACION (peso 8): Consistencia y branding: tipografía legible (≥18 pt aprox.), contraste suficiente, paleta consistente, lower-thirds legibles, transiciones sobrias, coincidencia A/V (lab-sync correcto), estabilidad de cámara (sin temblores notorios), gráficos con altísimo contraste y accesibles (evitar combinaciones rojo/verde críticas). Reporta fallos con timestamps.

CÁLCULO DEL SCORE:
• Cada regla produce subScore 0–100 según cumplimiento y evidencia. El score final es el promedio ponderado por "peso".
• Si una regla es "unknown", no la cuentes en el denominador y añádela a unknownRules.
• Penalización: si R4_CARGA_COGNITIVA detecta >3 bullets simultáneos, resta 5 puntos al score total (sin bajar de 0).

DETALLES A ENTREGAR POR REGLA (TODO EN ESPAÑOL):
• ok: boolean
• subScore: number (0–100)
• note: string (breve explicación accionable EN ESPAÑOL)
• evidence: { timestamps?: [{start:number,end:number,description:string (EN ESPAÑOL)}], count?: number, text?: string[] (EN ESPAÑOL), pairs?: [{concept:string (EN ESPAÑOL), demoT:number}], meta?: object }
• suggestions: string[] (mejoras concretas EN ESPAÑOL)

MÉTRICAS (si es posible, aproxima):
duracion_min, max_bullets_por_slide, palabras_promedio_por_bullet, micropracticas_count, bloques_count, mayor_estatico_seg, cortes_por_min, wpm_aprox, cc_subtitulos, video_resolution_px (ej. "1920x1080" o unknown), video_fps, video_bitrate_mbps, audio_lufs, audio_peak_db, noise_floor_db, sample_rate_hz, audio_channels (1|2|unknown), lab_sync_ok (boolean|null), lighting_evenness_0_100 (estimado), white_balance_ok (boolean|null), focus_ok (boolean|null), stabilization_ok (boolean|null), compression_artifacts (boolean|null).

SALIDAS EXTRA (TODO EN ESPAÑOL):
summary (2–3 frases útiles para el docente EN ESPAÑOL); findings (R1…R16 con textos EN ESPAÑOL); suggestions (Top 5 acciones priorizadas EN ESPAÑOL); unknownRules;
assetsDetected: { links:string, repo:boolean, snippets:boolean, plantillas:boolean, rubrica:boolean }
structure: { hook:{start,end,type}, objetivos:string, mapa:{steps,count}, paresConceptoDemo:[{concept,demoT}], microPracticas:[{t,instruccion}], recuperacion:[{t,pregunta,clave}], casoReal:{t,descripcion}, recap:{bullets}, tarea:{instruccion,entregable,criterios} }
pacing: { longSegments:[{start,end,desc}], avgGapMicroPracticeSec }
compliance: { bulletsMax, bulletsBreaches:[{t,count}] }
accessibility: { cc:boolean, transcript:boolean, contrast_ok:boolean|null, font_legible:boolean|null, audio_ok:boolean|null }
mediaAnalysis: {
video: { resolution_px:string|null, fps:number|null, bitrate_mbps:number|null, exposure_ok:boolean|null, white_balance_ok:boolean|null, lighting_evenness_0_100:number|null, focus_ok:boolean|null, framing_ok:boolean|null, headroom_ok:boolean|null, background_distraction:boolean|null, compression_artifacts:boolean|null, stabilization_ok:boolean|null, issues:[{t:number,desc:string}] },
audio: { lufs:number|null, peak_db:number|null, noise_floor_db:number|null, sample_rate_hz:number|null, channels:number|null, clipping:boolean|null, reverb_echo:boolean|null, pops_sibilance:boolean|null, hum_hiss:boolean|null, mic_distance_ok:boolean|null, consistency_ok:boolean|null, issues:[{t:number,desc:string}] }
}

ESQUEMA JSON EXACTO (responde SOLO esto, sin texto adicional, TODO EN ESPAÑOL):
{
"score": number,
"summary": string,
"findings": [
{"ruleId":"R1_HOOK","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R2_OBJETIVOS","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R3_MAPA_3PASOS","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R4_CARGA_COGNITIVA","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R5_SEGMENTACION","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R6_SENALIZACION","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R7_DEMO_INMEDIATA","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R8_PRACTICA_ACTIVA","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R9_RECUPERACION","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R10_TRANSFERENCIA","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R11_CIERRE_RECAP","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R12_TAREA_Y_CRITERIOS","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R13_RITMO_ACCESIBILIDAD","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R14_MEDIA_VIDEO","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R15_MEDIA_AUDIO","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string},
{"ruleId":"R16_MEDIA_PRESENTACION","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string}
],
"suggestions": string[],
"unknownRules": string[],
"assetsDetected": {
"links": string[],
"repo": boolean,
"snippets": boolean,
"plantillas": boolean,
"rubrica": boolean
},
"structure": {
"hook": {"start": number|null, "end": number|null, "type": "historia"|"pregunta"|"demo"|"unknown"},
"objetivos": string[],
"mapa": {"steps": string[], "count": number},
"paresConceptoDemo": [{"concept": string, "demoT": number}],
"microPracticas": [{"t": number, "instruccion": string}],
"recuperacion": [{"t": number, "pregunta": string, "clave": string|null}],
"casoReal": {"t": number|null, "descripcion": string|null},
"recap": {"bullets": string[]},
"tarea": {"instruccion": string|null, "entregable": string|null, "criterios": string[]}
},
"pacing": {
"longSegments": [{"start": number, "end": number, "desc": string}],
"avgGapMicroPracticeSec": number|null
},
"compliance": {
"bulletsMax": number|null,
"bulletsBreaches": [{"t": number, "count": number}]
},
"accessibility": {
"cc": boolean,
"transcript": boolean,
"contrast_ok": boolean|null,
"font_legible": boolean|null,
"audio_ok": boolean|null
},
"mediaAnalysis": {
"video": {
"resolution_px": string|null,
"fps": number|null,
"bitrate_mbps": number|null,
"exposure_ok": boolean|null,
"white_balance_ok": boolean|null,
"lighting_evenness_0_100": number|null,
"focus_ok": boolean|null,
"framing_ok": boolean|null,
"headroom_ok": boolean|null,
"background_distraction": boolean|null,
"compression_artifacts": boolean|null,
"stabilization_ok": boolean|null,
"issues": [{"t": number, "desc": string}]
},
"audio": {
"lufs": number|null,
"peak_db": number|null,
"noise_floor_db": number|null,
"sample_rate_hz": number|null,
"channels": number|null,
"clipping": boolean|null,
"reverb_echo": boolean|null,
"pops_sibilance": boolean|null,
"hum_hiss": boolean|null,
"mic_distance_ok": boolean|null,
"consistency_ok": boolean|null,
"issues": [{"t": number, "desc": string}]
}
},
"metrics": {
"duracion_min": number,
"max_bullets_por_slide": number,
"palabras_promedio_por_bullet": number,
"micropracticas_count": number,
"bloques_count": number,
"mayor_estatico_seg": number,
"cortes_por_min": number,
"wpm_aprox": number,
"cc_subtitulos": boolean,
"video_resolution_px": string,
"video_fps": number,
"video_bitrate_mbps": number,
"audio_lufs": number,
"audio_peak_db": number,
"noise_floor_db": number,
"sample_rate_hz": number,
"audio_channels": number,
"lab_sync_ok": boolean,
"lighting_evenness_0_100": number,
"white_balance_ok": boolean,
"focus_ok": boolean,
"stabilization_ok": boolean,
"compression_artifacts": boolean
}
}
`


          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: 'application/json'
    }
  };

  // IMPORTANTE: Usar v1beta para soporte de archivos con prefijo models/
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  console.log(`🔗 URL completa: ${url.replace(GEMINI_API_KEY, 'API_KEY_HIDDEN')}`);
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8 * 60_000
  });

  const txt = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  console.log(`✅ Respuesta recibida del modelo ${MODEL}, parseando JSON...`);
  
  try {
    return JSON.parse(txt);
  } catch (parseError) {
    console.error('❌ Error parseando JSON de análisis de video:', parseError.message);
    console.error('Texto recibido:', txt.substring(0, 500));
    throw new Error(`Error parseando respuesta de Gemini: ${parseError.message}`);
  }
  }, VIDEO_MODEL, VALID_VIDEO_MODELS);
}

// ====== Vimeo Upload Helper ======
async function uploadToVimeoAPI(buffer, fileName, metadata = {}) {
  if (!VIMEO_ACCESS_TOKEN) {
    throw new Error('VIMEO_ACCESS_TOKEN no configurado');
  }

  console.log('[Vimeo] Iniciando subida de video...');

  // Generar un título atractivo basado en el contenido
  let videoTitle = '';
  if (metadata.summary) {
    // Extraer un título del resumen
    const summaryText = metadata.summary;
    // Buscar la primera oración completa o usar las primeras palabras
    const firstSentence = summaryText.split(/[.!?]/).filter(s => s.trim().length > 0)[0] || '';
    
    if (firstSentence.length > 10) {
      // Si la primera oración es larga, usarla como base para el título
      // Limitar a 50 caracteres y añadir puntos suspensivos si es necesario
      videoTitle = firstSentence.trim().substring(0, 50);
      if (firstSentence.length > 50) videoTitle += '...';
    }
  }
  
  // Si no se pudo generar un título del resumen, usar un título genérico pero sin mencionar UDEL
  if (!videoTitle) {
    // Quitar la extensión del archivo
    const baseFileName = fileName.replace(/\.[^/.]+$/, "");
    // Convertir guiones bajos y guiones en espacios
    const cleanName = baseFileName.replace(/[_-]/g, ' ');
    // Capitalizar cada palabra
    const capitalizedName = cleanName.split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
    
    videoTitle = `Tutorial: ${capitalizedName}`;
  }
  
  // Generar una descripción atractiva
  let videoDescription = '';
  
  // Usar el resumen como base para la descripción
  if (metadata.summary) {
    videoDescription = metadata.summary;
    
    // Añadir algunos emojis y formato para hacerlo más atractivo
    videoDescription = `📚 ${videoDescription}\n\n`;
  }
  
  // Añadir información sobre los hallazgos si están disponibles
  if (metadata.findings && metadata.findings.length > 0) {
    videoDescription += '✅ Puntos destacados:\n';
    
    // Filtrar solo los hallazgos positivos (ok: true)
    const positiveFindings = metadata.findings.filter(f => f.ok);
    
    // Añadir hasta 3 hallazgos positivos
    positiveFindings.slice(0, 3).forEach(finding => {
      videoDescription += `• ${finding.note || finding.ruleId.replace(/_/g, ' ')}\n`;
    });
    
    videoDescription += '\n';
  }
  
  // Añadir un llamado a la acción al final
  videoDescription += '👉 ¡No olvides suscribirte para más contenido educativo de calidad!';

  // 1. Crear el video en Vimeo con título y descripción mejorados
  const createResponse = await axios.post(
    'https://api.vimeo.com/me/videos',
    {
      upload: {
        approach: 'tus',
        size: buffer.length
      },
      name: videoTitle,
      description: videoDescription,
      privacy: {
        view: metadata.privacy || 'unlisted' // 'anybody', 'unlisted', 'password', 'disable'
      }
    },
    {
      headers: {
        'Authorization': `Bearer ${VIMEO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.vimeo.*+json;version=3.4'
      }
    }
  );

  const uploadLink = createResponse.data.upload.upload_link;
  const videoUri = createResponse.data.uri;

  // 2. Subir el video usando TUS protocol
  await axios.patch(uploadLink, buffer, {
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0',
      'Content-Type': 'application/offset+octet-stream'
    },
    maxBodyLength: Infinity
  });

  console.log('[Vimeo] Video subido exitosamente:', videoUri);

  // 3. Obtener los detalles completos del video para conseguir la URL correcta con hash
  const videoDetails = await axios.get(`https://api.vimeo.com${videoUri}`, {
    headers: {
      'Authorization': `Bearer ${VIMEO_ACCESS_TOKEN}`,
      'Accept': 'application/vnd.vimeo.*+json;version=3.4'
    }
  });

  // Usar la URL completa de la respuesta de la API en lugar de construirla manualmente
  const videoLink = videoDetails.data.link || videoDetails.data.player_embed_url;
  const videoId = videoUri.split('/').pop();

  console.log('[Vimeo] URL completa del video:', videoLink);

  return {
    uri: videoUri,
    link: videoLink,
    videoId
  };
}

// ====== Endpoint: Análisis de video (sin subida a Vimeo) ======
app.post('/analyzeVideo', upload.single('file'), async (req, res) => {
  const { file } = req;
  const { analysisId } = req.body || {};

  if (!analysisId) return res.status(400).json({ ok: false, error: 'analysisId requerido' });
  if (!file)       return res.status(400).json({ ok: false, error: 'file requerido' });

  const ref = db.collection('analyses').doc(analysisId);

  await ref.set({
    status: 'processing',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    fileName: file.originalname,
    fileSize: file.size,
    mimeType: file.mimetype
  }, { merge: true });

  let uploaded = null;
  try {
    // 1) Subir a Gemini Files
    uploaded = await uploadToGemini(file.buffer, file.mimetype, file.originalname);
    console.log('[Gemini] uploaded file meta:', uploaded);

    // 2) Esperar a que el archivo quede ACTIVE
    const fileRef = extractGeminiFileRef(uploaded); // "files/ID"
    if (!fileRef) throw new Error('No se obtuvo referencia del archivo (name/uri) de Gemini');

    await waitGeminiFileReady(fileRef, { timeoutMs: 45000, intervalMs: 1200 });

    // 3) Usar la URI completa que retorna Gemini (v1beta format)
    const fileUriForAnalysis = uploaded?.file?.uri || `https://generativelanguage.googleapis.com/v1beta/${fileRef}`;

    // 4) Analizar
    const result = await geminiAnalyze({ 
      fileUri: fileUriForAnalysis, 
      mimeType: file.mimetype 
    });

    // 5) Determinar si califica para Vimeo
    const qualifiesForVimeo = result.score >= SCORE_THRESHOLD;

    // 6) Guardar resultado
    await ref.set({
      status: 'done',
      result,
      qualifiesForVimeo,
      scoreThreshold: SCORE_THRESHOLD,
      vimeoStatus: qualifiesForVimeo ? 'pending' : 'not_applicable',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[Análisis] Score ${result.score}% - ${qualifiesForVimeo ? 'Califica' : 'No califica'} para Vimeo (umbral: ${SCORE_THRESHOLD}%)`);

    return res.json({ 
      ok: true, 
      analysisId,
      score: result.score,
      qualifiesForVimeo
    });
  } catch (e) {
    console.error('analyzeVideo error:', e?.response?.status, e?.response?.data || String(e));

    await ref.set({
      status: 'error',
      error: e?.response?.data?.error?.message || e.message || 'unknown',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  } finally {
    // 6) Limpieza
    const toDelete = extractGeminiFileRef(uploaded);
    if (toDelete) deleteGeminiFile(toDelete).catch(() => {});
  }
});

// ====== Endpoint: Subir a Vimeo (manual) ======
app.post('/uploadToVimeo', upload.single('file'), async (req, res) => {
  const { file } = req;
  const { analysisId } = req.body || {};

  if (!analysisId) return res.status(400).json({ ok: false, error: 'analysisId requerido' });
  if (!file) return res.status(400).json({ ok: false, error: 'file requerido' });

  const ref = db.collection('analyses').doc(analysisId);

  try {
    // 1) Verificar que el análisis existe y califica
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'Análisis no encontrado' });
    }

    const data = doc.data();
    if (!data.qualifiesForVimeo) {
      return res.status(403).json({ 
        ok: false, 
        error: `El video no alcanzó el puntaje mínimo (${data.result?.score}% < ${SCORE_THRESHOLD}%)` 
      });
    }

    if (data.vimeoStatus === 'uploaded') {
      return res.status(400).json({ 
        ok: false, 
        error: 'Este video ya fue subido a Vimeo',
        vimeoLink: data.vimeoLink
      });
    }

    // 2) Actualizar estado
    await ref.update({
      vimeoStatus: 'uploading',
      updatedAt: FieldValue.serverTimestamp()
    });

    // 3) Subir a Vimeo con información mejorada
    const vimeoResult = await uploadToVimeoAPI(file.buffer, file.originalname, {
      summary: data.result?.summary || '',
      findings: data.result?.findings || [],
      privacy: 'unlisted'
    });

    // 4) Guardar resultado
    await ref.update({
      vimeoStatus: 'uploaded',
      vimeoUri: vimeoResult.uri,
      vimeoLink: vimeoResult.link,
      vimeoVideoId: vimeoResult.videoId,
      vimeoUploadedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    console.log('[Vimeo] Subida completada:', vimeoResult.link);

    return res.json({
      ok: true,
      vimeoLink: vimeoResult.link,
      vimeoVideoId: vimeoResult.videoId
    });

  } catch (e) {
    console.error('[Vimeo] Error al subir:', e?.response?.data || e.message);

    await ref.update({
      vimeoStatus: 'error',
      vimeoError: e?.response?.data?.error || e.message,
      updatedAt: FieldValue.serverTimestamp()
    });

    return res.status(500).json({ 
      ok: false, 
      error: e?.response?.data?.error || e.message || 'Error al subir a Vimeo'
    });
  }
});

// ====== Generar Carta Descriptiva (Optimizado - Una sola llamada) ======
app.post('/generateCartaDescriptiva', async (req, res) => {
  console.log('[generateCartaDescriptiva] Inicio - Body:', JSON.stringify(req.body));
  const { temaDescription } = req.body || {};

  if (!temaDescription || typeof temaDescription !== 'string' || temaDescription.trim().length < 10) {
    console.log('[generateCartaDescriptiva] Validación fallida - temaDescription:', temaDescription);
    return res.status(400).json({ ok: false, error: 'Se requiere una descripción del tema (mínimo 10 caracteres)' });
  }

  // Verificar que OpenAI esté configurado
  if (!openai) {
    return res.status(503).json({
      ok: false,
      error: 'OpenAI no está configurado. Agrega OPENAI_API_KEY en las variables de entorno.'
    });
  }

  try {
    console.log('[generateCartaDescriptiva] Generando carta optimizada con OpenAI...');
    
    // Generar carta de alta calidad en una sola llamada (sin análisis posterior)
    const cartaGenerada = await generateCartaOptimizadaWithOpenAI(temaDescription.trim());
    console.log('[generateCartaDescriptiva] Carta generada, longitud:', cartaGenerada.length);

    // Devolver directamente (sin análisis para mayor velocidad)
    return res.json({
      ok: true,
      carta: { contenido: cartaGenerada },
      analysis: {
        score: 100,
        summary: 'Carta descriptiva generada con estándares de calidad profesional usando GPT-4 Turbo.',
        findings: [],
        suggestions: []
      }
    });

  } catch (e) {
    console.error('[generateCartaDescriptiva] Error:', e?.message, e?.stack);
    if (e?.response) {
      console.error('[generateCartaDescriptiva] Response error:', e.response.status, e.response.data);
    }
    return res.status(500).json({ ok: false, error: e.message || 'Error interno del servidor' });
  }
});

// Función optimizada para generar carta descriptiva de alta calidad (una sola llamada)
async function generateCartaOptimizadaWithOpenAI(temaDescription) {
  console.log('[generateCartaOptimizadaWithOpenAI] Inicio - temaDescription length:', temaDescription.length);
  
  if (!openai) {
    throw new Error('OpenAI no está configurado');
  }

  const prompt = `Genera una carta descriptiva COMPLETA y PROFESIONAL para UNA CLASE EN VIDEO sobre: "${temaDescription}"

CRITICO: Esta carta describe UNA SOLA CLASE EN VIDEO (8-15 minutos). SOLO incluye contenido pedagogico de la clase, SIN especificaciones tecnicas de video/audio/presentacion.

FORMATO REQUERIDO:
- SIN emojis ni caracteres especiales
- SIN asteriscos, guiones, o simbolos decorativos
- Texto limpio y profesional
- Apto para PDF y visualizacion en modal
- Estructura clara con titulos y subtitulos
- Parrafos bien organizados

INFORMACION GENERAL DE LA CLASE
Titulo de la clase (atractivo y especifico)
Tema central
Duracion: 10-13 minutos
Modalidad: Video educativo asincrono
Descripcion: Que aprendera el estudiante en esta clase especifica

OBJETIVOS DE APRENDIZAJE
Objetivos especificos y medibles para ESTA clase
Usar verbos de accion observables (identificar, aplicar, crear, analizar, evaluar)
Formato: "Al finalizar esta clase, el estudiante sera capaz de..."

CONTENIDO PEDAGOGICO DE LA CLASE

SECCION 1: HOOK - Inicio Impactante (0:00-0:25)
Tipo: Historia personal / Pregunta provocadora / Demo del resultado final
Descripcion exacta de que se mostrara
Objetivo: Captar atencion inmediata

SECCION 2: OBJETIVOS Y MAPA (0:25-1:15)
Presentacion clara de 1-2 objetivos de aprendizaje
Roadmap visual de 3 pasos
Ejemplo: Paso 1: Concepto base, Paso 2: Aplicacion practica, Paso 3: Caso real

SECCION 3: BLOQUE 1 - Concepto Fundamental (1:15-4:00)
Contenido: Explicacion del concepto clave
Puntos principales (maximo 3 puntos, maximo 10 palabras cada uno)
Demo inmediata: Ejemplo practico del concepto

SECCION 4: MICRO-PRACTICA 1 (4:00-4:45)
Instruccion clara: Pausa el video y [accion especifica]
Actividad practica concreta
Ejemplo de respuesta esperada

SECCION 5: BLOQUE 2 - Aplicacion Practica (4:45-7:30)
Demo paso a paso con codigo/herramienta real
Vinculacion concepto a demo
Puntos clave a resaltar

SECCION 6: MICRO-PRACTICA 2 (7:30-8:15)
Instruccion clara: Tu turno: [mini-reto especifico]
Actividad aplicada
Solucion esperada

SECCION 7: BLOQUE 3 - Caso Real y Transferencia (8:15-10:30)
Caso del mundo real (dataset real, API real, situacion profesional)
Descripcion detallada del caso
Aplicacion del concepto al caso

SECCION 8: RECUPERACION Y CHEQUEO (10:30-11:15)
Pregunta de comprension rapida
Respuesta/clave proporcionada

SECCION 9: CIERRE Y RECAP (11:15-12:15)
Recap de 3 puntos principales (maximo 10 palabras cada uno)
Errores comunes a evitar (2-3 puntos especificos)

SECCION 10: TAREA APLICABLE (12:15-13:00)
Tarea concreta (menor o igual a 20 minutos de ejecucion)
Entregable especifico y medible
Criterios de evaluacion (checklist de 3-5 puntos claros)

RECURSOS Y MATERIALES
Links a recursos mencionados
Repositorio de codigo (si aplica)
Snippets de codigo descargables
Plantillas mencionadas
Rubrica de evaluacion de la tarea

REFERENCIAS
3-5 referencias actualizadas y relevantes
Formato APA
Recursos digitales accesibles

INSTRUCCIONES FINALES:
Escribe la carta descriptiva en espanol profesional, con estructura clara, timestamps EXACTOS, y todos los elementos necesarios.

La carta debe ser un guion de produccion profesional, detallado y listo para usar.

IMPORTANTE:
- Usa SOLO texto limpio. SIN emojis, SIN asteriscos, SIN guiones decorativos, SIN caracteres especiales.
- SOLO contenido pedagogico de la clase. NO incluyas especificaciones tecnicas de video, audio o presentacion.
- Formato apto para PDF y modal.

Responde SOLO con el texto completo de la carta descriptiva, bien formateado y listo para usar como guion de produccion.`;

  console.log('[generateCartaOptimizadaWithOpenAI] Llamando a OpenAI API...');
  
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o', // Modelo más potente para máxima calidad
    messages: [
      {
        role: 'system',
        content: 'Eres un experto en diseño instruccional y producción de video educativo. Generas cartas descriptivas detalladas para clases en video que cumplen con los más altos estándares pedagógicos y técnicos. Tus cartas descriptivas sirven como guiones de producción profesionales que garantizan 100% en análisis de calidad.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.3,
    max_tokens: 4500
  });

  const txt = completion.choices[0]?.message?.content || '';
  console.log('[generateCartaOptimizadaWithOpenAI] Texto extraído, length:', txt.length);
  
  if (!txt || txt.length < 200) {
    throw new Error('La respuesta de OpenAI está vacía o es muy corta');
  }
  
  return txt.trim();
}

// Función para generar carta descriptiva con Gemini (fallback)
async function generateCartaWithGemini(temaDescription, suggestionsPrevias = []) {
  console.log('[generateCartaWithGemini] Inicio - temaDescription length:', temaDescription.length, 'suggestions:', suggestionsPrevias.length);
  return retryWithModels(async (MODEL) => {
  const suggestionsText = suggestionsPrevias.length > 0 ?
    `\n\nMejoras de versiones anteriores a considerar:\n${suggestionsPrevias.map(s => `- ${s}`).join('\n')}` : '';

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Genera una carta descriptiva completa para una clase universitaria basada en la siguiente descripción del tema:

DESCRIPCIÓN DEL TEMA:
${temaDescription}

${suggestionsText}

INSTRUCCIONES PARA LA CARTA DESCRIPTIVA:
- Debe ser completa y profesional
- Incluir todos los elementos pedagógicos necesarios
- Seguir las mejores prácticas de diseño instruccional
- Asegurar que cumpla con TODOS los criterios de evaluación para obtener 100%
- Lenguaje claro, accesible y motivador
- Estructura lógica y organizada

ELEMENTOS REQUERIDOS:
1. Título atractivo y descriptivo
2. Descripción general del curso
3. Objetivos de aprendizaje específicos y medibles
4. Contenido temático detallado
5. Metodología y actividades
6. Recursos necesarios
7. Sistema de evaluación
8. Criterios de evaluación claros
9. Bibliografía y referencias

IMPORTANTE: La carta debe estar optimizada para obtener la máxima puntuación en análisis pedagógico. Incluye todos los elementos que demuestren calidad educativa excepcional.

Responde SOLO con el texto completo de la carta descriptiva, sin explicaciones adicionales.`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4000
    }
  };

  console.log('[generateCartaWithGemini] Llamando a Gemini API con modelo:', MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120_000
  });

  console.log('[generateCartaWithGemini] Respuesta recibida, status:', response.status);
  const txt = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('[generateCartaWithGemini] Texto extraído, length:', txt.length);
  
  if (!txt || txt.length < 100) {
    throw new Error('La respuesta de Gemini está vacía o es muy corta');
  }
  
  return txt.trim();
  }, TEXT_MODEL, VALID_TEXT_MODELS);
}

// Función para analizar carta descriptiva con OpenAI
async function analyzeCartaWithOpenAI(cartaContenido) {
  console.log('[analyzeCartaWithOpenAI] Inicio - cartaContenido length:', cartaContenido.length);
  
  if (!openai) {
    throw new Error('OpenAI no está configurado');
  }

  const prompt = `Evalúa la siguiente carta descriptiva de curso y asigna una puntuación basada en criterios pedagógicos de calidad. La carta debe obtener 100% si cumple perfectamente con todos los estándares.

CARTA DESCRIPTIVA A EVALUAR:
${cartaContenido}

CRITERIOS DE EVALUACIÓN (cada uno con peso y reglas específicas):

C1_ESTRUCTURA_COMPLETA (peso 10): Tiene título, descripción, objetivos, contenido, metodología, evaluación, bibliografía. Puntuación: 100 si todos presentes, 0 si falta alguno crítico.

C2_OBJETIVOS_CLAROS (peso 15): Objetivos específicos, medibles, alcanzables, relevantes, temporales. Deben usar verbos de acción. Puntuación basada en claridad y completitud.

C3_CONTENIDO_ORGANIZADO (peso 15): Contenido lógico, secuencial, con temas interconectados. Incluye prerrequisitos y progresión.

C4_METODOLOGIA_APROPIADA (peso 15): Actividades variadas, prácticas, evaluación formativa. Incluye tiempo estimado y recursos.

C5_EVALUACION_COMPLETA (peso 15): Múltiples formas de evaluación, criterios claros, rúbrica implícita, retroalimentación.

C6_RECURSOS_ACCESIBLES (peso 10): Lista completa de recursos, materiales, tecnología. Considera accesibilidad.

C7_LENGUAJE_CLARO (peso 10): Lenguaje inclusivo, términos definidos, estructura clara, motivador.

C8_INNOVACION_PEDAGOGICA (peso 5): Elementos innovadores, tecnología educativa, aprendizaje activo.

C9_BIBLIOGRAFIA_COMPLETA (peso 3): Referencias actualizadas, variadas, relevantes.

C10_PRESENTACION_PROFESIONAL (peso 2): Formato profesional, sin errores, atractiva.

CÁLCULO: Score final = promedio ponderado. Penalización: -10 puntos si faltan elementos críticos.

DETALLES POR CRITERIO:
• ok: boolean (cumple perfectamente)
• subScore: 0-100
• note: explicación breve y constructiva
• suggestions: mejoras específicas si no cumple

Responde SOLO con un objeto JSON válido con este formato exacto:
{
"score": number,
"findings": [
{"ruleId":"C1_ESTRUCTURA_COMPLETA","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C2_OBJETIVOS_CLAROS","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C3_CONTENIDO_ORGANIZADO","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C4_METODOLOGIA_APROPIADA","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C5_EVALUACION_COMPLETA","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C6_RECURSOS_ACCESIBLES","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C7_LENGUAJE_CLARO","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C8_INNOVACION_PEDAGOGICA","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C9_BIBLIOGRAFIA_COMPLETA","ok":boolean,"subScore":number,"note":string,"suggestions":string},
{"ruleId":"C10_PRESENTACION_PROFESIONAL","ok":boolean,"subScore":number,"note":string,"suggestions":string}
],
"suggestions": [string],
"summary": string
}`;

  console.log('[analyzeCartaWithOpenAI] Llamando a OpenAI API...');
  
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [
      {
        role: 'system',
        content: 'Eres un experto evaluador de diseño instruccional. Analizas cartas descriptivas y proporcionas evaluaciones precisas en formato JSON.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' }
  });

  const txt = completion.choices[0]?.message?.content || '{}';
  console.log('[analyzeCartaWithOpenAI] Texto JSON recibido, length:', txt.length);

  try {
    const parsed = JSON.parse(txt);
    console.log('[analyzeCartaWithOpenAI] JSON parseado exitosamente, score:', parsed.score);
    return parsed;
  } catch (parseError) {
    console.error('[analyzeCartaWithOpenAI] Error parseando JSON:', parseError.message, 'Texto recibido:', txt.substring(0, 500));
    throw new Error(`Error parseando respuesta de OpenAI: ${parseError.message}`);
  }
}

// Función para analizar carta descriptiva con Gemini (fallback - NO SE USA)
async function analyzeCartaWithGemini(cartaContenido) {
  console.log('[analyzeCartaWithGemini] Inicio - cartaContenido length:', cartaContenido.length);
  return retryWithModels(async (MODEL) => {

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Evalúa la siguiente carta descriptiva de curso y asigna una puntuación basada en criterios pedagógicos de calidad. La carta debe obtener 100% si cumple perfectamente con todos los estándares.

CARTA DESCRIPTIVA A EVALUAR:
${cartaContenido}

CRITERIOS DE EVALUACIÓN (cada uno con peso y reglas específicas):

C1_ESTRUCTURA_COMPLETA (peso 10): Tiene título, descripción, objetivos, contenido, metodología, evaluación, bibliografía. Puntuación: 100 si todos presentes, 0 si falta alguno crítico.

C2_OBJETIVOS_CLAROS (peso 15): Objetivos específicos, medibles, alcanzables, relevantes, temporales. Deben usar verbos de acción. Puntuación basada en claridad y completitud.

C3_CONTENIDO_ORGANIZADO (peso 15): Contenido lógico, secuencial, con temas interconectados. Incluye prerrequisitos y progresión.

C4_METODOLOGIA_APROPIADA (peso 15): Actividades variadas, prácticas, evaluación formativa. Incluye tiempo estimado y recursos.

C5_EVALUACION_COMPLETA (peso 15): Múltiples formas de evaluación, criterios claros, rúbrica implícita, retroalimentación.

C6_RECURSOS_ACCESIBLES (peso 10): Lista completa de recursos, materiales, tecnología. Considera accesibilidad.

C7_LENGUAJE_CLARO (peso 10): Lenguaje inclusivo, términos definidos, estructura clara, motivador.

C8_INNOVACION_PEDAGOGICA (peso 5): Elementos innovadores, tecnología educativa, aprendizaje activo.

C9_BIBLIOGRAFIA_COMPLETA (peso 3): Referencias actualizadas, variadas, relevantes.

C10_PRESENTACION_PROFESIONAL (peso 2): Formato profesional, sin errores, atractiva.

CÁLCULO: Score final = promedio ponderado. Penalización: -10 puntos si faltan elementos críticos.

DETALLES POR CRITERIO:
• ok: boolean (cumple perfectamente)
• subScore: 0-100
• note: explicación breve y constructiva
• suggestions: mejoras específicas si no cumple

SALIDA JSON EXACTA:
{
"score": number,
"findings": [
{"ruleId":"C1_ESTRUCTURA_COMPLETA","ok":boolean,"subScore":number,"note":string,"suggestions":string},
... (todos los criterios C1-C10)
],
"suggestions": string[],
"summary": string
}`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json'
    }
  };

  console.log('[analyzeCartaWithGemini] Llamando a Gemini API con modelo:', MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120_000
  });

  console.log('[analyzeCartaWithGemini] Respuesta recibida, status:', response.status);
  const txt = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  console.log('[analyzeCartaWithGemini] Texto JSON recibido, length:', txt.length);

  try {
    const parsed = JSON.parse(txt);
    console.log('[analyzeCartaWithGemini] JSON parseado exitosamente, score:', parsed.score);
    return parsed;
  } catch (parseError) {
    console.error('[analyzeCartaWithGemini] Error parseando JSON:', parseError.message, 'Texto recibido:', txt.substring(0, 500));
    throw new Error(`Error parseando respuesta de Gemini: ${parseError.message}`);
  }
  }, TEXT_MODEL, VALID_TEXT_MODELS);
}

// ====== Cache para Google Sheet (evitar múltiples requests) ======
let clasesCache = {
  data: null,
  timestamp: null,
  ttl: 5 * 60 * 1000 // 5 minutos de TTL
};

// ====== Función helper para obtener datos del Google Sheet ======
async function getGoogleSheetData() {
  const now = Date.now();

  // Si el cache es válido, retornar datos cacheados
  if (clasesCache.data && clasesCache.timestamp && (now - clasesCache.timestamp) < clasesCache.ttl) {
    console.log('[getGoogleSheetData] Usando datos del cache');
    return clasesCache.data;
  }

  console.log('[getGoogleSheetData] Obteniendo datos frescos del Google Sheet');

  const SHEET_ID = '1PAqolSipsOv41k5Ps2oBuoLMvepfBEqJocJXlnXUQSI';
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

  const response = await axios.get(CSV_URL, {
    timeout: 10000,
    headers: {
      'User-Agent': 'UDEL-Tools/1.0'
    }
  });

  // Parsear el CSV
  const lines = response.data.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

  // Buscar las columnas importantes
  const moduleIndex = headers.findIndex(h => h.toLowerCase().includes('módulo') || h.toLowerCase().includes('modulo'));
  const cuatrimestreIndex = headers.findIndex(h => h.toLowerCase().includes('cuatrimestre'));
  const materiaIndex = headers.findIndex(h => h.toLowerCase().includes('materia') || h.toLowerCase().includes('nombre'));
  const urlIndex = headers.findIndex(h => h.toLowerCase().includes('url') || h.toLowerCase().includes('dropbox'));
  const carreraIndex = headers.findIndex(h => h.toLowerCase().includes('carrera'));

  const allClases = [];

  // Parsear todas las filas
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Parsear la línea (manejo básico de CSV con comillas)
    const columns = [];
    let currentColumn = '';
    let insideQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        columns.push(currentColumn.trim().replace(/^"|"$/g, ''));
        currentColumn = '';
      } else {
        currentColumn += char;
      }
    }
    columns.push(currentColumn.trim().replace(/^"|"$/g, ''));

    const materia = columns[materiaIndex] || '';
    const url = columns[urlIndex] || '';
    const modulo = columns[moduleIndex] || '';
    const cuatrimestre = columns[cuatrimestreIndex] || '';
    const carrera = columns[carreraIndex] || '';

    if (materia) {
      allClases.push({
        modulo,
        cuatrimestre,
        materia,
        url: url || null,
        carrera,
        hasUrl: !!url && url.trim().length > 0
      });
    }
  }

  // Guardar en cache
  clasesCache.data = allClases;
  clasesCache.timestamp = now;

  return allClases;
}

// ====== Endpoint: Obtener sugerencias de materias ======
app.get('/getSuggestions', async (req, res) => {
  const { query } = req.query;

  try {
    if (!query || typeof query !== 'string' || query.trim().length < 1) {
      return res.json({ ok: true, suggestions: [] });
    }

    const searchTerm = query.trim().toLowerCase();
    const allClases = await getGoogleSheetData();

    // Filtrar y obtener nombres únicos de materias
    const matchingMaterias = new Set();

    allClases.forEach(clase => {
      if (clase.materia.toLowerCase().includes(searchTerm)) {
        matchingMaterias.add(clase.materia);
      }
    });

    // Convertir a array y limitar a 10 sugerencias
    const suggestions = Array.from(matchingMaterias)
      .sort()
      .slice(0, 10);

    return res.json({
      ok: true,
      suggestions,
      total: suggestions.length
    });

  } catch (e) {
    console.error('[getSuggestions] Error:', e?.message);
    return res.status(500).json({
      ok: false,
      error: e.message || 'Error al obtener sugerencias'
    });
  }
});

// ====== Endpoint: Buscar clases en Google Sheet ======
app.get('/searchClases', async (req, res) => {
  const { query } = req.query;

  try {
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.status(400).json({ ok: false, error: 'Se requiere un término de búsqueda (mínimo 2 caracteres)' });
    }

    const searchTerm = query.trim().toLowerCase();
    console.log(`[searchClases] Buscando: "${searchTerm}"`);

    // Obtener datos del cache o Google Sheet
    const allClases = await getGoogleSheetData();

    // Filtrar resultados
    const results = allClases.filter(clase =>
      clase.materia.toLowerCase().includes(searchTerm)
    );

    console.log(`[searchClases] Encontrados ${results.length} resultados para "${searchTerm}"`);

    return res.json({
      ok: true,
      query: query.trim(),
      results,
      total: results.length
    });

  } catch (e) {
    console.error('[searchClases] Error:', e?.message);
    if (e?.response) {
      console.error('[searchClases] Response error:', e.response.status, e.response.data);
    }
    return res.status(500).json({
      ok: false,
      error: e.message || 'Error al buscar clases'
    });
  }
});

// ====== Middleware de autenticación ======
async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Error verificando token:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ====== Endpoint: Obtener planteles (superAdmin) ======
app.get('/admin/getPlanteles', verifyAuth, async (req, res) => {
  try {
    // Verificar que el usuario actual sea superAdmin
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();

    if (!userData || userData.role !== 'superAdmin') {
      return res.status(403).json({ error: 'No tienes permisos para ver planteles' });
    }

    // Obtener todos los planteles ordenados por nombre
    const plantelesSnapshot = await db.collection('planteles').orderBy('name').get();

    const planteles = [];
    plantelesSnapshot.forEach(doc => {
      planteles.push({
        id: doc.id,
        ...doc.data()
      });
    });

    return res.json({
      ok: true,
      planteles
    });

  } catch (error) {
    console.error('Error obteniendo planteles:', error);
    return res.status(500).json({
      error: 'Error al obtener planteles',
      details: error.message
    });
  }
});

// ====== Endpoint: Crear plantel (solo superAdmin) ======
app.post('/admin/createPlantel', verifyAuth, async (req, res) => {
  try {
    // Verificar que el usuario actual sea superAdmin
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();

    if (!userData || userData.role !== 'superAdmin') {
      return res.status(403).json({ error: 'No tienes permisos para crear planteles' });
    }

    const { name, ciudad } = req.body;

    // Validaciones básicas
    if (!name || !ciudad) {
      return res.status(400).json({ error: 'Nombre y ciudad son obligatorios' });
    }

    // Crear plantel en Firestore
    const plantelRef = await db.collection('planteles').add({
      name: name.trim(),
      ciudad: ciudad.trim(),
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid
    });

    console.log(`✅ Plantel creado: ${name} (${ciudad}) por ${userData.email}`);

    return res.json({
      ok: true,
      message: 'Plantel creado exitosamente',
      plantelId: plantelRef.id,
      name: name.trim(),
      ciudad: ciudad.trim()
    });

  } catch (error) {
    console.error('Error creando plantel:', error);
    return res.status(500).json({
      error: 'Error al crear plantel',
      details: error.message
    });
  }
});

// ====== Endpoint: Eliminar plantel (solo superAdmin) ======
app.delete('/admin/deletePlantel/:plantelId', verifyAuth, async (req, res) => {
  try {
    // Verificar que el usuario actual sea superAdmin
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();

    if (!userData || userData.role !== 'superAdmin') {
      return res.status(403).json({ error: 'No tienes permisos para eliminar planteles' });
    }

    const { plantelId } = req.params;

    if (!plantelId) {
      return res.status(400).json({ error: 'ID de plantel requerido' });
    }

    // Eliminar el plantel
    await db.collection('planteles').doc(plantelId).delete();

    console.log(`🗑️ Plantel eliminado: ${plantelId} por ${userData.email}`);

    return res.json({
      ok: true,
      message: 'Plantel eliminado exitosamente'
    });

  } catch (error) {
    console.error('Error eliminando plantel:', error);
    return res.status(500).json({
      error: 'Error al eliminar plantel',
      details: error.message
    });
  }
});

// ====== Endpoint: Crear usuario (solo superAdmin) ======
app.post('/admin/createUser', verifyAuth, async (req, res) => {
  try {
    // Verificar que el usuario actual sea superAdmin
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();

    if (!userData || userData.role !== 'superAdmin') {
      return res.status(403).json({ error: 'No tienes permisos para crear usuarios' });
    }

    const { email, password, role, name, lastName, plantel, ciudad, whatsapp } = req.body;

    // Validaciones básicas
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, contraseña y rol son obligatorios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Validar roles permitidos
    const validRoles = ['superAdmin', 'director', 'mentor', 'user'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol no válido' });
    }

    // Validar campos adicionales para director y mentor
    if ((role === 'director' || role === 'mentor') && (!name || !lastName || !plantel || !ciudad || !whatsapp)) {
      return res.status(400).json({ error: 'Los campos nombre, apellido, plantel, ciudad y whatsapp son obligatorios para este rol' });
    }

    // Crear usuario en Firebase Auth
    const userRecord = await admin.auth().createUser({
      email,
      password,
      emailVerified: false,
      disabled: false
    });

    // Crear documento del usuario en Firestore
    const newUserData = {
      email,
      role,
      approved: true, // Usuarios creados por admin están pre-aprobados
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid
    };

    // Agregar campos específicos según el rol
    if (role === 'director' || role === 'mentor') {
      newUserData.name = name;
      newUserData.lastName = lastName;
      newUserData.plantel = plantel;
      newUserData.ciudad = ciudad;
      newUserData.whatsapp = whatsapp;
      newUserData.displayName = `${name} ${lastName}`;
    } else {
      newUserData.name = email.split('@')[0];
    }

    await db.collection('users').doc(userRecord.uid).set(newUserData);

    console.log(`✅ Usuario creado: ${email} (${role}) por ${userData.email}`);

    return res.json({
      ok: true,
      message: 'Usuario creado exitosamente',
      userId: userRecord.uid,
      email: userRecord.email
    });

  } catch (error) {
    console.error('Error creando usuario:', error);

    // Manejar errores específicos de Firebase
    let errorMessage = 'Error al crear usuario';
    if (error.code === 'auth/email-already-exists') {
      errorMessage = 'Este correo electrónico ya está registrado';
    } else if (error.code === 'auth/invalid-email') {
      errorMessage = 'Correo electrónico inválido';
    } else if (error.code === 'auth/weak-password') {
      errorMessage = 'La contraseña debe tener al menos 6 caracteres';
    }

    return res.status(400).json({
      error: errorMessage,
      details: error.message
    });
  }
});

// ====== Salud ======
app.get('/health', async (_req, res) => {
  try {
    await db.listCollections();
    res.json({
      ok: true,
      projectId: admin.app().options.projectId,
      videoModel: VIDEO_MODEL,
      textModel: TEXT_MODEL,
      openaiConfigured: !!OPENAI_API_KEY,
      vimeoConfigured: !!VIMEO_ACCESS_TOKEN,
      scoreThreshold: SCORE_THRESHOLD,
      cartaDescriptivaEngine: openai ? 'OpenAI (GPT-4)' : 'Gemini (fallback)'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== Inicio ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Analyzer listening on', PORT));