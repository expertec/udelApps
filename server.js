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
`Evalúa el video adjunto con este enfoque “Clase tipo Platzi”. Usa el audio + transcripción + metadatos si están disponibles. NO inventes datos: si algo no puede detectarse, márcalo como "unknown". Responde SOLO JSON con el esquema indicado.

REGLAS (con IDs y pesos para el score):
- R1_HOOK (peso 10): Inicia con historia/pregunta/demostración del resultado (<=60s). Detecta si existe, su tipo y su timestamp inicial y final.
- R2_OUTCOMES (peso 10): Declara 1–2 objetivos de aprendizaje medibles en los primeros 90s. Extrae texto si aparece.
- R3_MAPA (peso 8): Presenta un mapa de 3–4 pasos (roadmap) al inicio (<=90s). Cuenta bullets/pasos.
- R4_BULLETS_MAX3 (peso 6): En pantalla o en voz, no usar más de 3 bullets simultáneos. Cuenta el máximo detectado y dónde ocurre.
- R5_DEMO_MICROLOGROS (peso 14): Hay demo práctica con micro-logros cada 60–90s (ej.: test pasa, endpoint responde, UI cambia). Lista micro-logros con timestamps.
- R6_PRACTICA (peso 12): Deja una tarea “tu turno” con verificación esperada (output/criterios). Extrae instrucción y expected output si existe.
- R7_RECAP_CTA (peso 8): Cierra con recap breve (qué se logró) + siguiente paso/CTA (qué viene en el curso).
- R8_RECURSOS (peso 8): Provee recursos concretos (repo, snippet, .env ejemplo, diagrama, links docs). Lista los detectados.
- R9_RITMO (peso 12): Ritmo ágil: cortes/pausas útiles; segmentos sin valor explicativo >120s penalizan. Detecta segmentos densos (timestamps).
- R10_AUDIO_VIDEO (peso 12): Audio claro (sin ruido notable, volumen estable), tipografía legible (>=16–18pt), contraste suficiente. Marca problemas si se perciben.

CÁLCULO DE SCORE:
- Cada regla produce un sub-score 0–100 según cumplimiento y evidencias. El score final es el promedio ponderado por “peso”. Si una regla es "unknown", ignórala del denominador y repórtala en "unknownRules".
- Si R4_BULLETS_MAX3 se incumple, resta adicionalmente 5 puntos al total (pero nunca por debajo de 0).

DETALLES QUE DEBES ENTREGAR POR REGLA:
- ok: boolean
- subScore: number (0–100)
- note: string (breve explicación)
- evidence: { timestamps?: [{start:number,end:number,description:string}], count?: number, text?: string[] }
- suggestions: string[] (acciones específicas, p.ej. “reduce bullets a 3”, “agrega expected output”)

SALIDAS EXTRA:
- summary: Máx 2–3 frases, enfoque en utilidad para el creador de la clase.
- findings: arreglo con los objetos por regla (en el orden R1…R10).
- suggestions: Top 5 acciones priorizadas (una por línea, imperativas).
- unknownRules: string[] con los ruleId no evaluables.
- assetsDetected: { links: string[], repo:boolean, snippets:boolean, envExample:boolean, diagram:boolean }
- structure: { hook:{start,end,type}, outcomes:string[], mapa:{steps:string[], count:number}, microLogros:[{t:number,desc:string}], practica:{instruccion:string, expected:string}, recap:boolean, cta:string|null }
- pacing: { longSegments:[{start,end,desc}], avgMicroLogroGapSec:number|null }
- compliance: { bulletsMax:int, bulletsBreaches:[{t:number,count:int}] }

ESQUEMA JSON EXACTO:
{
  "score": number,               // 0–100 final ponderado (aplica penalización de R4 si corresponde)
  "summary": string,
  "findings": [
    {"ruleId":"R1_HOOK","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R2_OUTCOMES","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R3_MAPA","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R4_BULLETS_MAX3","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R5_DEMO_MICROLOGROS","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R6_PRACTICA","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R7_RECAP_CTA","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R8_RECURSOS","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R9_RITMO","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]},
    {"ruleId":"R10_AUDIO_VIDEO","ok":boolean,"subScore":number,"note":string,"evidence":object,"suggestions":string[]}
  ],
  "suggestions": string[],        // Top 5 acciones priorizadas
  "unknownRules": string[],
  "assetsDetected": {
    "links": string[],
    "repo": boolean,
    "snippets": boolean,
    "envExample": boolean,
    "diagram": boolean
  },
  "structure": {
    "hook": {"start": number|null, "end": number|null, "type": "historia"|"pregunta"|"demo"|"unknown"},
    "outcomes": string[],
    "mapa": {"steps": string[], "count": number},
    "microLogros": [{"t": number, "desc": string}],
    "practica": {"instruccion": string|null, "expected": string|null},
    "recap": boolean,
    "cta": string|null
  },
  "pacing": {
    "longSegments": [{"start": number, "end": number, "desc": string}],
    "avgMicroLogroGapSec": number|null
  },
  "compliance": {
    "bulletsMax": number|null,
    "bulletsBreaches": [{"t": number, "count": number}]
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