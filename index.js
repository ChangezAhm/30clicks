const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const archiver = require('archiver');
const { google } = require('googleapis');
const { bucket } = require('./firebase-config');
const { uploadToDropboxFromFirebase, uploadToDropboxWithRetry, dropboxAuth } = require('./dropbox-utils');

const app = express();
const PORT = process.env.PORT || 5500;

// Initialize Google Drive API
let driveService;

async function initializeGoogleDrive() {
  try {
    // Decode the base64 encoded credentials
    const credentialsJson = Buffer.from(process.env.GOOGLE_DRIVE_CREDENTIALS, 'base64').toString();
    const credentials = JSON.parse(credentialsJson);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    driveService = google.drive({ version: 'v3', auth });
    console.log('✅ Google Drive API initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize Google Drive:', error);
  }
}

// Call initialization on startup
initializeGoogleDrive();

// Scheduled token refresh every 3 hours
setInterval(async () => {
  try {
    await dropboxAuth.refreshAccessToken();
    console.log('⏰ Scheduled token refresh completed');
  } catch (error) {
    console.error('❌ Scheduled token refresh failed:', error);
  }
}, 3 * 60 * 60 * 1000); // 3 hours

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: true,
  preflightContinue: true
}));

app.use(express.json());

// Configure email transporter
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Set up multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
}).single('image');

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Upload endpoint - uploads to Firebase
app.post('/upload', (req, res) => {
  console.log('Upload request received', req.query);

  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ success: false, error: 'Upload failed', details: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    try {
      const { address } = req.query;
      if (!address) {
        return res.status(400).json({ success: false, error: 'Address is required' });
      }

      const folderName = address.replace(/[^a-z0-9]/gi, '_');
      const timestamp = Date.now();
      const filename = `${timestamp}-${req.file.originalname}`;
      const filePath = `${folderName}/${filename}`;
      const fileRef = bucket.file(filePath);

      const stream = fileRef.createWriteStream({ metadata: { contentType: req.file.mimetype } });

      stream.on('error', (error) => {
        console.error('Upload to Firebase failed:', error);
        res.status(500).json({ success: false, error: 'Failed to upload to cloud storage', details: error.message });
      });

      stream.on('finish', async () => {
        await fileRef.makePublic();
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        console.log('File uploaded successfully to Firebase:', publicUrl);
        res.json({ success: true, message: 'Image uploaded successfully', fileUrl: publicUrl, timestamp: new Date().toISOString() });
      });

      stream.end(req.file.buffer);
    } catch (error) {
      console.error('Server error during upload:', error);
      res.status(500).json({ success: false, error: 'Server error', details: error.message });
    }
  });
});

// Function to upload to Google Drive
async function uploadToGoogleDrive(filePath, fileName, parentFolderId = null) {
  try {
    if (!driveService) {
      throw new Error('Google Drive service not initialized');
    }

    // Get file from Firebase
    const file = bucket.file(filePath);
    const [buffer] = await file.download();

    // Create file metadata
    const fileMetadata = {
      name: fileName,
      parents: parentFolderId ? [parentFolderId] : undefined,
    };

    // Get file type
    const mimeType = 'image/jpeg'; // Assuming all files are JPEG

    // Upload to Google Drive
    const drive = await driveService.files.create({
      resource: fileMetadata,
      media: {
        mimeType,
        body: buffer,
      },
    });

    console.log(`✅ Uploaded ${fileName} to Google Drive:`, drive.data.id);
    return drive.data;
  } catch (error) {
    console.error(`❌ Error uploading ${fileName} to Google Drive:`, error);
    throw error;
  }
}

// Function to create folder in Google Drive
async function createGoogleDriveFolder(folderName, parentFolderId = null) {
  try {
    if (!driveService) {
      throw new Error('Google Drive service not initialized');
    }

    // Check if folder already exists
    const existingFolders = await driveService.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'${parentFolderId ? ` and '${parentFolderId}' in parents` : ''}`,
      fields: 'files(id, name)',
    });

    if (existingFolders.data.files && existingFolders.data.files.length > 0) {
      console.log(`📁 Folder '${folderName}' already exists`);
      return existingFolders.data.files[0];
    }

    // Create new folder
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentFolderId ? [parentFolderId] : undefined,
    };

    const folder = await driveService.files.create({
      resource: fileMetadata,
      fields: 'id, name',
    });

    console.log(`✅ Created Google Drive folder '${folderName}':`, folder.data.id);
    return folder.data;
  } catch (error) {
    console.error(`❌ Error creating Google Drive folder '${folderName}':`, error);
    throw error;
  }
}

// Create folder endpoint (Firebase auto-creates)
app.post('/upload/create-folder', (req, res) => {
  const { address } = req.query;
  if (!address) {
    return res.status(400).json({ success: false, error: 'Address is required' });
  }

  try {
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    console.log('Folder for Firebase will be created automatically:', folderName);
    res.json({ success: true, message: 'Folder will be created automatically on first upload', path: folderName });
  } catch (error) {
    console.error('Error processing folder request:', error);
    res.status(500).json({ success: false, error: 'Failed to process folder request', details: error.message });
  }
});

// Download photos endpoint
app.get('/download-photos/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${address}-photos.zip"`);
    archive.pipe(res);

    const [files] = await bucket.getFiles({ prefix: folderName + '/' });
    for (const file of files) {
      if (file.name !== folderName + '/') {
        const stream = file.createReadStream();
        const fileName = file.name.split('/').pop();
        archive.append(stream, { name: fileName });
      }
    }

    archive.finalize();
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to create download', details: error.message });
  }
});

// ✅ /notify-print: INSTANT response with background processing (WITH GOOGLE DRIVE)
app.post('/notify-print', async (req, res) => {
  try {
    const { address, photoCount, userDetails, skipToPrint } = req.body;
    console.log('Print notification received:', { address, photoCount, skipToPrint });

    // ✅ IMMEDIATELY respond to the app - don't make user wait
    res.json({ 
      success: true, 
      message: 'Print request received. Processing in background...' 
    });

    // ✅ Process everything in background (async, non-blocking)
    setImmediate(async () => {
      try {
        const actualPhotoCount = 30 - photoCount;
        const folderName = address.replace(/[^a-z0-9]/gi, '_');

        // Get the total number of photos in the folder
        const folderPrefix = `${folderName}/`;
        const [files] = await bucket.getFiles({ prefix: folderPrefix });
        const totalPhotoCount = files.filter(file => file.name !== folderPrefix).length;

        // Background task 1: Upload to Dropbox and Google Drive (parallel)
        const uploadPromise = (async () => {
          try {
            console.log(`📦 Starting uploads for ${folderName}...`);
            
            // Wait for Firebase uploads to settle
            console.log('⏳ Waiting 5 seconds for Firebase uploads to settle...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const filesToUpload = files.filter(file => file.name !== folderPrefix);
            console.log(`📁 Found ${filesToUpload.length} files to upload`);

            // Create Google Drive folder first
            let driveFolder = null;
            try {
              driveFolder = await createGoogleDriveFolder(folderName, process.env.GOOGLE_DRIVE_FOLDER_ID);
            } catch (error) {
              console.error('Error creating Google Drive folder:', error);
            }

            // Upload to Dropbox and Google Drive sequentially for each file
            for (let i = 0; i < filesToUpload.length; i++) {
              const file = filesToUpload[i];
              const filename = file.name.split('/').pop();
              
              console.log(`📤 Uploading ${i + 1}/${filesToUpload.length}: ${filename}`);
              
              // Upload to Dropbox (with retry logic)
              const dropboxPath = `/30-clicks-import/${folderName}/${filename}`;
              let dropboxSuccess = false;
              let retryCount = 0;
              const maxRetries = 3;
              
              while (!dropboxSuccess && retryCount < maxRetries) {
                try {
                  await uploadToDropboxFromFirebase(file.name, dropboxPath);
                  console.log(`✅ Uploaded ${filename} to Dropbox (attempt ${retryCount + 1})`);
                  dropboxSuccess = true;
                } catch (err) {
                  retryCount++;
                  console.warn(`⚠️ Dropbox upload failed for ${filename} (attempt ${retryCount}/${maxRetries}):`, err.message);
                  
                  if (retryCount < maxRetries) {
                    let backoffDelay = 2000;
                    if (err.message && err.message.includes('too_many_write_operations')) {
                      backoffDelay = 5000;
                    } else {
                      backoffDelay = Math.min(2000 * Math.pow(2, retryCount - 1), 8000);
                    }
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                  }
                }
              }

              // Upload to Google Drive (parallel with Dropbox retries)
              if (driveFolder) {
                try {
                  await uploadToGoogleDrive(file.name, filename, driveFolder.id);
                  console.log(`✅ Uploaded ${filename} to Google Drive`);
                } catch (error) {
                  console.error(`❌ Failed to upload ${filename} to Google Drive:`, error);
                }
              }
              
              // Add delay between files
              if (i < filesToUpload.length - 1) {
                console.log('⏳ Waiting 2.5s before next upload...');
                await new Promise(resolve => setTimeout(resolve, 2500));
              }
            }
            
            console.log('📦 All uploads completed');
          } catch (error) {
            console.error('Upload batch error:', error);
          }
        })();

        // Background task 2: Send email (parallel)
        const emailPromise = (async () => {
          try {
            const emailSubject = skipToPrint 
              ? `⏩ PRINT REQUEST: ${address} (${totalPhotoCount} photos - SKIPPED TO PRINT)`
              : `✅ PRINT REQUEST: ${address} (${totalPhotoCount} photos - FULL ROLL)`;

            const emailHtml = `
              <h2>🖨️ New Print Request</h2>
              <p><strong>Address:</strong> ${address}</p>
              <p><strong>Total Photos:</strong> ${totalPhotoCount}</p>
              <p><strong>Photos Taken:</strong> ${actualPhotoCount}/30</p>
              <p><strong>Status:</strong> ${skipToPrint ? '⏩ Skipped to print' : '✅ Completed full roll'}</p>
              <h3>📥 Download Options:</h3>
              <div style="background-color: #e8f4fd; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <h4>Option 1: One-Click Download (Recommended)</h4>
                <p><a href="https://three0clicks.onrender.com/download-photos/${address}" style="background-color: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">📁 Download All Photos as ZIP</a></p>
              </div>
              <div style="background-color: #f0f0f0; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <h4>Option 2: Manual Download</h4>
                <p>1. Go to <a href="https://console.cloud.google.com/storage/browser/clicks-25b5a.firebasestorage.app/${folderName}">Google Cloud Console</a></p>
                <p>2. Select all photos individually and download</p>
              </div>
              <div style="background-color: #e8f5e9; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <h4>Option 3: Dropbox (Auto-synced)</h4>
                <p>📁 Check your Dropbox: <code>/30-clicks-import/${folderName}/</code></p>
                <p><small>Photos are automatically uploaded to Dropbox for your convenience. This may take 2-3 minutes to complete.</small></p>
              </div>
              <div style="background-color: #e1f5fe; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <h4>Option 4: Google Drive (Auto-synced)</h4>
                <p>📁 Check your Google Drive: <code>/30-clicks-photos/${folderName}/</code></p>
                <p><small>Photos are automatically uploaded to Google Drive for easy access and sharing.</small></p>
              </div>
              <p><strong>User Details:</strong></p>
              <ul>
                <li><strong>Username:</strong> ${userDetails.username}</li>
                <li><strong>Postcode:</strong> ${userDetails.postcode}</li>
                <li><strong>House Number:</strong> ${userDetails.houseNumber}</li>
              </ul>
              <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
            `;

            await transporter.sendMail({
              from: process.env.EMAIL_USER,
              to: process.env.FOUNDER_EMAIL,
              subject: emailSubject,
              html: emailHtml
            });

            console.log('📧 Print notification email sent successfully');
          } catch (error) {
            console.error('Email sending error:', error);
          }
        })();

        // Run both tasks in parallel
        await Promise.all([uploadPromise, emailPromise]);
        console.log('🎉 All background tasks completed for', address);

      } catch (error) {
        console.error('Background processing error:', error);
      }
    });

  } catch (error) {
    console.error('Error in notify-print endpoint:', error);
    // Still respond immediately even if there's an error
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to process request', 
        details: error.message 
      });
    }
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('=================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Access it from your device at:`);
  console.log(`→ http://localhost:${PORT}`);
  console.log(`→ http://<YOUR_LOCAL_IP>:${PORT}`);
  console.log('=================================');
  
  // Initial token refresh on startup
  setTimeout(async () => {
    try {
      await dropboxAuth.refreshAccessToken();
      console.log('🚀 Initial Dropbox token refresh completed');
    } catch (error) {
      console.error('❌ Initial token refresh failed:', error);
    }
  }, 2000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down...');
  process.exit(0);
});