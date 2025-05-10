const admin = require('firebase-admin');

let serviceAccount;
if (process.env.FIREBASE_CONFIG) {
  // When deployed (on Render.com)
  serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
} else {
  // Local development
  serviceAccount = require('./serviceAccountKey.json');
}

// Initialize Firebase with the correct bucket name
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'clicks-25b5a.firebasestorage.app'  // <-- Updated bucket name
});

const bucket = admin.storage().bucket();

// Log bucket info for debugging
console.log('Using Firebase Storage bucket:', bucket.name);

module.exports = { admin, bucket };