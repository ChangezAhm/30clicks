const fetch = require('node-fetch');
const { bucket } = require('./firebase-config');

async function uploadToDropboxFromFirebase(filePath, dropboxPath) {
  const token = process.env.DROPBOX_TOKEN;
  const file = bucket.file(filePath);
  const [buffer] = await file.download();

  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: 'add',
        autorename: true,
        mute: false
      })
    },
    body: buffer
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Dropbox upload failed:', err);
    throw new Error('Failed to upload to Dropbox');
  }

  console.log('Uploaded to Dropbox:', dropboxPath);
}

module.exports = { uploadToDropboxFromFirebase };