// ====== Config base ======
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { admin, db, FieldValue } from './firebaseAdmin.js';

const app = express();
app.use(cors());               // restringe orígenes si quieres
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-1.5-pro'; // también vale 'gemini-1.5-pro-002'
if (!GEMINI_API_KEY) {
  throw new Error('Falta GEMINI_API_KEY');
}

// ====== Multer (memoria) ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) return cb(new Error('Solo video/*'), false);
    cb(null, true);
  }
});

// ====== Gemini: subir archivo y analizar ======
async function uploadToGemini(buffer, mimeType, fileName) {
  // 1) Crear recurso de subida (resumible)
  const initRes = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
    null,
    {
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      params: { fileId: fileName?.slice(0,80) || undefined },
      timeout: 60_000,
    }
  );
  const uploadUrl = initRes.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('No se obtuvo upload URL de Gemini');

  // 2) Subir contenido
  await axios.post(uploadUrl, buffer, {
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    maxBodyLength: Infinity,
    timeout: 10 * 60_000,
  });

  // 3) Obtener metadatos del file
  const metaRes = await axios.get(uploadUrl, { timeout: 30_000 });
  // metaRes.data: { name, display_name, uri, mime_type, ... }
  return metaRes.data; // devuelve {name, uri, mime_type, ...}
}

async function deleteGeminiFile(fileNameOrUri) {
  try {
    // Puedes pasar name: "files/abc123" (name) o uri (mismo value aceptado)
    const id = String(fileNameOrUri).replace(/^.*files\//, '');
    await axios.delete(
      `https://generativelanguage.googleapis.com/v1beta/files/${id}?key=${GEMINI_API_KEY}`,
      { timeout: 30_000 }
    );
  } catch (e) {
    console.warn('No se pudo borrar el archivo en Gemini:', e?.response?.status, e?.response?.data || String(e));
  }
}

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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8 * 60_000
  });

  // respuesta típica: { candidates:[{ content:{parts:[{text:"{...json...}"}]} }] }
  const txt = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(txt);
}

// ====== Endpoint ======
app.post('/analyzeVideo', upload.single('file'), async (req, res) => {
  const { file } = req;
  const { analysisId } = req.body || {};
  if (!analysisId) return res.status(400).json({ ok: false, error: 'analysisId requerido' });
  if (!file) return res.status(400).json({ ok: false, error: 'file requerido' });

  // marca processing (solo si quieres ver el doc de inmediato)
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
    const fileUri = uploaded?.uri; // ej: "files/abc123"
    if (!fileUri) throw new Error('No se obtuvo fileUri de Gemini');

    // 2) Analizar
    const result = await geminiAnalyze({ fileUri, mimeType: file.mimetype });

    // 3) Guardar resultado
    await ref.set({
      status: 'done',
      result,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true, analysisId });
  } catch (e) {
    console.error('analyzeVideo error:', e?.response?.status, e?.response?.data || String(e));
    await ref.set({
      status: 'error',
      error: e?.response?.data?.error?.message || e.message || 'unknown',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  } finally {
    // 4) limpieza del archivo remoto
    if (uploaded?.name || uploaded?.uri) {
      deleteGeminiFile(uploaded.name || uploaded.uri).catch(() => {});
    }
  }
});

// opcional: /health mejorado
app.get('/health', async (req, res) => {
  try {
    await db.listCollections();
    res.json({ ok: true, projectId: admin.app().options.projectId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Analyzer listening on', PORT));
