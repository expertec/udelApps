// firebaseAdmin.js
import admin from "firebase-admin";

const svc = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: svc
      ? admin.credential.cert(svc)
      : admin.credential.applicationDefault(),
  });
}

export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
