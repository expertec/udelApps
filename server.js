// server.js - Analyzer API (Render)

// ====== Dependencias ======
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import { admin, db, FieldValue } from './firebaseAdmin.js';

// ====== App básica ======
const app = express();
app.use(cors());
app.use(express.json());

// ====== Entorno ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RAW_MODEL = process.env.GEMINI_MODEL || 'models/gemini-1.5-pro-002';
const GEMINI_MODEL = RAW_MODEL.startsWith('models/') ? RAW_MODEL : `models/${RAW_MODEL}`;
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
  const MODEL = GEMINI_MODEL;
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

`Evalúa el video adjunto como clase en video optimizada para atención y aprendizaje.  No inventes datos: si algo no puede detectarse, márcalo como "unknown". Responde SOLO JSON con el esquema indicado al final.

REGLAS (basadas en mejores prácticas de aprendizaje, con IDs y pesos):

R1_HOOK (peso 8): Inicio con historia/pregunta/demo del resultado <=30s. Detecta tipo y timestamps.

R2_OBJETIVOS (peso 8): 1–2 objetivos observables al inicio (<=90s) con verbo de logro (“crear”, “resolver”, “comparar”). Extrae texto si aparece.

R3_MAPA_3PASOS (peso 6): Roadmap de máx. 3 pasos visible o verbal. Cuenta pasos y ubicación.

R4_CARGA_COGNITIVA (peso 8): Diapositivas limpias (≤3 bullets simultáneos, ≤10 palabras/bullet). Reporta máximos y breaches.

R5_SEGMENTACION (peso 8): Clase en 2–4 bloques con señalización (“Parte 1/3”, títulos, marcadores). Lista bloques con timestamps.

R6_SENALIZACION (peso 6): Guías visuales/verbales (cursor, zoom, resaltado, “Paso 2 de 3”) al introducir conceptos. Evidencia con momentos.

R7_DEMO_INMEDIATA (peso 8): Tras cada concepto clave hay demo/ejemplo práctico inmediato. Vincula concepto→demo por timestamp.

R8_PRACTICA_ACTIVA (peso 12): ≥2 micro-prácticas (tu turno/pausa/mini-reto) intercaladas cada 2–4 min. Lista instrucciones y tiempos.

R9_RECUPERACION (peso 8): Chequeo rápido de recuerdo/compresión (pregunta, mini-quiz) con retro breve. Detecta ítems y respuesta/clave si existe.

R10_TRANSFERENCIA (peso 8): Caso/aplicación al mundo real (dataset, API, situación realista). Describe el caso y dónde ocurre.

R11_CIERRE_RECAP (peso 6): Recap de 3 bullets (≤10 palabras c/u) + errores comunes. Extrae texto si aparece.

R12_TAREA_Y_CRITERIOS (peso 12): Tarea aplicable (≤20 min) con entregable y criterios de evaluación (rubrica/checklist). Extrae ambos si existen.

R13_RITMO_ACCESIBILIDAD (peso 12): Ritmo ágil (sin pantalla estática >20s; cortes/cambios cada 60–90s), audio inteligible (volumen estable, sin ruido), y accesibilidad (subtítulos/CC o transcripción). Marca problemas si se perciben.

CÁLCULO DEL SCORE:

Cada regla produce subScore 0–100 según cumplimiento y evidencia. El score final es el promedio ponderado por “peso”.

Si una regla es "unknown", no la cuentes en el denominador y añádela a unknownRules.

Penalización: si R4_CARGA_COGNITIVA detecta >3 bullets simultáneos, resta 5 puntos al score total (sin bajar de 0).

DETALLES A ENTREGAR POR REGLA:

ok: boolean

subScore: number (0–100)

note: string (breve explicación accionable)

evidence: { timestamps?: [{start:number,end:number,description:string}], count?: number, text?: string[], pairs?: [{concept:string, demoT:number}] }

suggestions: string[] (mejoras concretas: “limita a 3 bullets”, “inserta micro-reto al min 3”)

MÉTRICAS (si es posible, aproxima):

duracion_min (number)

max_bullets_por_slide (number)

palabras_promedio_por_bullet (number)

micropracticas_count (number)

bloques_count (number)

mayor_estatico_seg (number)

cortes_por_min (number)

wpm_aprox (number)

cc_subtitulos (boolean)

SALIDAS EXTRA:

summary: 2–3 frases útiles para el docente.

findings: arreglo con objetos por regla (R1…R13).

suggestions: Top 5 acciones priorizadas (una por línea, imperativas).

unknownRules: string[] con los ruleId no evaluables.

assetsDetected: { links:string, repo:boolean, snippets:boolean, plantillas:boolean, rubrica:boolean }

structure: {
hook:{start:number|null,end:number|null,type:"historia"|"pregunta"|"demo"|"unknown"},
objetivos:string,
mapa:{steps:string,count:number},
paresConceptoDemo:[{concept:string, demoT:number}],
microPracticas:[{t:number, instruccion:string}],
recuperacion:[{t:number, pregunta:string, clave:string|null}],
casoReal:{t:number|null, descripcion:string|null},
recap:{bullets:string},
tarea:{instruccion:string|null, entregable:string|null, criterios:string}
}

pacing: { longSegments:[{start:number,end:number,desc:string}], avgGapMicroPracticeSec:number|null }

compliance: { bulletsMax:number|null, bulletsBreaches:[{t:number,count:number}] }

accessibility: { cc:boolean, transcript:boolean, contrast_ok:boolean|null, font_legible:boolean|null, audio_ok:boolean|null }

ESQUEMA JSON EXACTO (responde SOLO esto, sin texto adicional):
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
{"ruleId":"R13_RITMO_ACCESIBILIDAD","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string}
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
"metrics": {
"duracion_min": number,
"max_bullets_por_slide": number,
"palabras_promedio_por_bullet": number,
"micropracticas_count": number,
"bloques_count": number,
"mayor_estatico_seg": number,
"cortes_por_min": number,
"wpm_aprox": number,
"cc_subtitulos": boolean
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

  // IMPORTANTE: Usar v1beta para soporte de archivos
  const url = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8 * 60_000
  });

  const txt = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(txt);
}

// ====== Endpoint principal ======
app.post('/analyzeVideo', upload.single('file'), async (req, res) => {
  const { file } = req;
  const { analysisId } = req.body || {};

  if (!analysisId) return res.status(400).json({ ok: false, error: 'analysisId requerido' });
  if (!file)       return res.status(400).json({ ok: false, error: 'file requerido' });

  const ref = db.collection('analyses').doc(analysisId);

  await ref.set({
    status: 'processing',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
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

    // 5) Guardar resultado
    await ref.set({
      status: 'done',
      result,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({ ok: true, analysisId });
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

// ====== Salud ======
app.get('/health', async (_req, res) => {
  try {
    await db.listCollections();
    res.json({ ok: true, projectId: admin.app().options.projectId, model: GEMINI_MODEL });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== Inicio ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Analyzer listening on', PORT));