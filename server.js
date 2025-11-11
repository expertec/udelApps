// server.js - Analyzer API (Render)
// Ejecuta: node server.js

// ====== Dependencias ======
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import { admin, db, FieldValue } from './firebaseAdmin.js';

// ====== App básica ======
const app = express();
app.use(cors());                 // Ajusta origin si quieres restringir
app.use(express.json());

// ====== Entorno ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Normaliza el modelo: acepta "gemini-1.5-pro-002" o "models/gemini-1.5-pro-002"
const RAW_MODEL = process.env.GEMINI_MODEL || 'models/gemini-1.5-pro-002';
const GEMINI_MODEL = RAW_MODEL.startsWith('models/') ? RAW_MODEL : `models/${RAW_MODEL}`;

if (!GEMINI_API_KEY) {
  throw new Error('Falta GEMINI_API_KEY');
}

// ====== Multer (memoria) ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('video/')) return cb(new Error('Solo se aceptan archivos de video'), false);
    cb(null, true);
  }
});


// Extrae la referencia válida para file_uri desde la respuesta de files:upload
function extractGeminiFileRef(uploaded) {
  const f = uploaded?.file;
  if (!f) return null;
  if (f.name) return f.name; // "files/xxxx"
  if (f.uri) {
    const m = f.uri.match(/\/files\/([^/]+)$/);
    return m ? `files/${m[1]}` : f.uri;
  }
  return null;
}


// ====== Gemini: subida y análisis ======

// Sube el buffer como archivo a Gemini Files (resumable) y devuelve el objeto File { name, uri, mime_type, ... }
async function uploadToGemini(buffer, mimeType, fileName) {
  // 1) Iniciar subida resumible con metadatos en el body
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

  // 2) Subir datos + finalizar; la respuesta YA es el objeto File
  const finalizeRes = await axios.post(uploadUrl, buffer, {
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    maxBodyLength: Infinity,
    timeout: 10 * 60_000,
  });

  return finalizeRes.data; // { name, uri, mime_type, ... }
}

// Borra el archivo remoto en Gemini Files (best-effort)
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

// Llama a generateContent con file_uri
async function geminiAnalyze({ fileUri, mimeType }) {
  const body = {
    contents: [
      {
        role: 'system',
        parts: [{ text: 'Eres un evaluador académico preciso y estricto, devuelves solo JSON válido.' }]
      },
      {
        role: 'user',
        parts: [
          {
            text:
`Evalúa el video adjunto con estas reglas:
- R1: Debe iniciar con una historia corta (sí/no y explica brevemente con timestamps si es posible).
- R2: Incluir máximo 3 bullets (sí/no, cuenta los bullets y explica).
- R3: Debe dejar una tarea al alumno (sí/no, describe la tarea; si falta, sugiere una).

Responde SOLO JSON con este esquema:
{
  "score": number,
  "summary": string,
  "findings": [
    {"ruleId":"R1","ok":boolean,"note":string},
    {"ruleId":"R2","ok":boolean,"note":string},
    {"ruleId":"R3","ok":boolean,"note":string}
  ],
  "suggestions": string[]
}`
          },
          { file_data: { file_uri: fileUri, mime_type: mimeType } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: 'application/json'
    }
  };

  // Usa v1 aquí. Si en env tienes "models/gemini-1.5-pro-002", déjalo tal cual.
  const RAW_MODEL = process.env.GEMINI_MODEL || 'models/gemini-1.5-pro-002';
  const MODEL = RAW_MODEL.startsWith('models/') ? RAW_MODEL : `models/${RAW_MODEL}`;

  const url = `https://generativelanguage.googleapis.com/v1/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8 * 60_000
  });

  const txt = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(txt);
}



// Espera hasta que el archivo esté ACTIVE en Gemini Files
async function waitGeminiFileReady(fileRef, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const id = String(fileRef).replace(/^.*files\//, ''); // "files/abc" | ".../files/abc" -> "abc"
  const url = `https://generativelanguage.googleapis.com/v1beta/files/${id}?key=${GEMINI_API_KEY}`;

  const start = Date.now();
  for (;;) {
    const r = await axios.get(url, { timeout: 10000 });
    const state = r?.data?.file?.state || r?.data?.state;
    if (state === 'ACTIVE') return r.data.file || r.data; // listo
    if (Date.now() - start > timeoutMs) throw new Error(`El archivo en Gemini no quedó listo a tiempo (estado: ${state || 'desconocido'})`);
    await new Promise(res => setTimeout(res, intervalMs));
  }
}


// ====== Endpoint principal ======
// ====== Endpoint principal (reemplaza toda esta función) ======
// ====== Endpoint principal (reemplaza toda esta función) ======
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

    // 2) Obtener referencia y esperar readiness
    const fileRef = extractGeminiFileRef(uploaded);
    if (!fileRef) throw new Error('No se obtuvo referencia del archivo (name/uri) de Gemini');

    await waitGeminiFileReady(fileRef, { timeoutMs: 45000, intervalMs: 1200 });

    // 3) Analizar con Gemini (v1)
    const result = await geminiAnalyze({ fileUri: fileRef, mimeType: file.mimetype });

    // 4) Guardar resultado
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
    // 5) Limpieza (best-effort)
    const toDelete = extractGeminiFileRef(uploaded);
    if (toDelete) {
      deleteGeminiFile(toDelete).catch(() => {});
    }
  }
});





// ====== Endpoint de salud ======
app.get('/health', async (_req, res) => {
  try {
    await db.listCollections(); // fuerza auth con Firestore
    res.json({
      ok: true,
      projectId: admin.app().options.projectId,
      model: GEMINI_MODEL
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== Inicio ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Analyzer listening on', PORT));
