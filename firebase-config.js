const admin = require('firebase-admin');

let serviceAccount;
if (process.env.FIREBASE_CONFIG) {
  // When deployed (on Render.com)
  serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
} else {
  // Local development
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'clicks-25b5a.appspot.com' // Replace with your actual project ID
});

const bucket = admin.storage().bucket();

module.exports = { admin, bucket };