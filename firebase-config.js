// firebase-config.js
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // You'll create this file in Step 4

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'clicks-25b5a' // You'll replace this with your Firebase project ID
});

const bucket = admin.storage().bucket();

module.exports = { admin, bucket };