// server.js - Analyzer API (Render)

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

// ====== Helpers Gemini Files ======

// Extrae una referencia válida "files/xxxxx" desde la respuesta de files:upload
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

// Espera a que el archivo subido quede ACTIVE antes de generar
async function waitGeminiFileReady(fileRef, { timeoutMs = 45000, intervalMs = 1200 } = {}) {
  const id = String(fileRef).replace(/^.*files\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/files/${id}?key=${GEMINI_API_KEY}`;
  const start = Date.now();
  for (;;) {
    const r = await axios.get(url, { timeout: 10000 });
    const state = r?.data?.file?.state || r?.data?.state;
    if (state === 'ACTIVE') return r.data.file || r.data;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`El archivo en Gemini no quedó listo (estado: ${state || 'desconocido'})`);
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
}

// Sube el buffer como archivo a Gemini Files (resumable) y devuelve el objeto { file: { name, uri, ... } }
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

  // 2) Subir datos + finalizar; la respuesta YA es el objeto con la clave "file"
  const finalizeRes = await axios.post(uploadUrl, buffer, {
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    maxBodyLength: Infinity,
    timeout: 10 * 60_000,
  });

  return finalizeRes.data; // { file: { name, uri, mimeType, state, ... } }
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

// ====== Gemini: generateContent ======
// Intenta v1 (camelCase). Si el payload es rechazado, cae a v1beta (snake_case).
// SOLO v1 (camelCase). Sin fallback a v1beta.
// Reemplaza COMPLETO tu geminiAnalyze por esta
const fileRef = extractGeminiFileRef(uploaded);               // "files/ID" (para esperar)
if (!fileRef) throw new Error('No se obtuvo referencia del archivo (name/uri) de Gemini');

await waitGeminiFileReady(fileRef, { timeoutMs: 45000, intervalMs: 1200 });

// Usa la URL completa para v1 (¡importante!)
const fullFileUrl =
  uploaded?.file?.uri ||
  `https://generativelanguage.googleapis.com/v1beta/${fileRef}`;

// 3) Analizar con Gemini (v1 + camelCase)
const result = await geminiAnalyze({ fileUri: fullFileUrl, mimeType: file.mimetype });



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

    // 2) Obtener referencia y esperar readiness
    const fileRef = extractGeminiFileRef(uploaded);
    if (!fileRef) throw new Error('No se obtuvo referencia del archivo (name/uri) de Gemini');

    await waitGeminiFileReady(fileRef, { timeoutMs: 45000, intervalMs: 1200 });

    // 3) Analizar con Gemini
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
