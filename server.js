// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { db, FieldValue } from "./firebaseAdmin.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Multer en MEMORIA (no se guarda en disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 500 }, // hasta 500 MB
  fileFilter: (req, file, cb) => {
    const ok = (file.mimetype || "").startsWith("video/");
    cb(ok ? null : new Error("Solo video/*"), ok);
  },
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = process.env.GEMINI_MODEL || "models/gemini-1.5-pro";

// ---------- helpers Gemini ----------
async function geminiUploadFile(buffer, filename, mimeType) {
  const url = `${GEMINI_BASE}/files?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const fd = new FormData();
  fd.append("file", buffer, { filename, contentType: mimeType });
  const res = await axios.post(url, fd, {
    headers: fd.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 1000 * 60 * 10,
  });
  return res.data; // { name, uri, ... }
}

async function geminiDeleteFile(fileName) {
  const url = `${GEMINI_BASE}/${encodeURIComponent(fileName)}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  try { await axios.delete(url, { timeout: 1000 * 60 }); } catch {}
}

async function geminiAnalyze({ fileUri, mimeType }) {
  // Rúbrica fija (puedes parametrizarla)
  const system = "Eres un evaluador académico preciso y estricto, devuelves solo JSON válido.";
  const userInstruction = `
Evalúa el video adjunto con estas reglas:
- R1: Debe iniciar con una historia corta (sí/no y explica brevemente con timestamps si es posible).
- R2: Incluir máximo 3 bullets (sí/no, cuenta los bullets y explica).
- R3: Debe dejar una tarea al alumno (sí/no, describe la tarea; si falta, sugiere una).

Responde SOLO JSON con este esquema:
{
  "score": number,                 // 0-100 ponderando R1,R2,R3 en partes iguales
  "summary": string,               // 3-5 oraciones
  "findings": [
    {"ruleId":"R1","ok":boolean,"note":string},
    {"ruleId":"R2","ok":boolean,"note":string},
    {"ruleId":"R3","ok":boolean,"note":string}
  ],
  "suggestions": string[]          // recomendaciones accionables según el contenido detectado
}
  `.trim();

  const url = `${GEMINI_BASE}/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const payload = {
    contents: [
      { role: "system", parts: [{ text: system }] },
      {
        role: "user",
        parts: [
          { text: userInstruction },
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: "application/json"
    },
  };

  const res = await axios.post(url, payload, { timeout: 1000 * 60 * 8 });
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { score: 0, summary: "", findings: [], suggestions: [] }; }
  return parsed;
}

// ---------- API ----------
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/analyzeVideo", upload.single("file"), async (req, res) => {
  try {
    const { file } = req;
    const { analysisId } = req.body || {};

    if (!analysisId) return res.status(400).send("analysisId is required");
    if (!file) return res.status(400).send("file is required");
    if (!GEMINI_API_KEY) return res.status(500).send("GEMINI_API_KEY not set");

    const docRef = db.collection("analyses").doc(analysisId);
    await docRef.set(
      { status: "processing", updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    // 1) Subir temporalmente a Gemini
    const uploaded = await geminiUploadFile(
      file.buffer,
      file.originalname || "video.mp4",
      file.mimetype || "video/mp4"
    );

    let result;
    try {
      // 2) Analizar
      result = await geminiAnalyze({
        fileUri: uploaded?.uri,
        mimeType: file.mimetype || "video/mp4",
      });
    } finally {
      // 3) Borrar en Gemini (no persistimos video)
      if (uploaded?.name) await geminiDeleteFile(uploaded.name);
    }

    // 4) Guardar resultado en Firestore
    await docRef.set(
      {
        status: "done",
        result,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ ok: true, analysisId });

  } catch (err) {
    console.error(err);
    const analysisId = req.body?.analysisId;
    if (analysisId) {
      try {
        await db.collection("analyses").doc(analysisId).set(
          {
            status: "error",
            error: String(err?.message || err),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch {}
    }
    res.status(500).send(String(err?.message || err));
  }
});

// Render asigna PORT automáticamente
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Analyzer listening on", PORT);
});
