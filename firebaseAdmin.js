// firebaseAdmin.js — SOLO LEE EL SECRET FILE
import admin from 'firebase-admin';
import fs from 'fs';

const SECRET_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_FILE
  || '/etc/secrets/FIREBASE_SERVICE_ACCOUNT_JSON';

if (!fs.existsSync(SECRET_PATH)) {
  throw new Error(`No existe el Secret File en ${SECRET_PATH}`);
}

const raw = fs.readFileSync(SECRET_PATH, 'utf8');
const sa = JSON.parse(raw);

// Normaliza saltos de línea en la private_key
if (sa.private_key && sa.private_key.includes('\\n')) {
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
}

if (!sa.project_id) {
  throw new Error('El Service Account no contiene project_id');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id, // fuerza projectId para evitar "Unable to detect a Project Id"
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

export { admin, db, FieldValue };
