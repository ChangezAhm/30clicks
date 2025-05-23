const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const archiver = require('archiver');
const { bucket } = require('./firebase-config');
const { uploadToDropboxFromFirebase, uploadToDropboxWithRetry, dropboxAuth } = require('./dropbox-utils');

const app = express();
const PORT = process.env.PORT || 5500;

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

// Configure email transport
const transport = nodemailer.createTransport({
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

      // Clean up the address for folder name
      const folderName = address.replace(/[^a-z0-9]/gi, '_');
      
      // Check if this address already includes album info (from client)
      // If not, try to get it from the query parameters
      let albumNumber = 1;
      if (!folderName.includes('album')) {
        // Extract album info from query parameters or body if available
        albumNumber = req.query.albumNumber || req.body?.userDetails?.currentAlbumNumber || 1;
      }
      
      // Extract user details from query parameters
      const postcode = req.query.postcode || '';
      const houseNumber = req.query.houseNumber || '';
      const username = req.query.username || '';
      
      const timestamp = Date.now();
      
      // Create enhanced filename with album number, postcode, house number, and username
      const enhancedFilename = `album${albumNumber}_${postcode}_${houseNumber}_${username}_${timestamp}-${req.file.originalname}`;
      
      // Include album subfolder in the path
      const filePath = `${folderName}/album${albumNumber}/${enhancedFilename}`;
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

// Create folder endpoint (Firebase auto-creates)
app.post('/upload/create-folder', (req, res) => {
  const { address } = req.query;
  const albumNumber = req.query.albumNumber || 1;
  
  if (!address) {
    return res.status(400).json({ success: false, error: 'Address is required' });
  }

  try {
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    const albumPath = `${folderName}/album${albumNumber}`;
    console.log('Folder for Firebase will be created automatically:', albumPath);
    res.json({ 
      success: true, 
      message: 'Folder structure will be created automatically on first upload', 
      path: albumPath 
    });
  } catch (error) {
    console.error('Error processing folder request:', error);
    res.status(500).json({ success: false, error: 'Failed to process folder request', details: error.message });
  }
});

// Download photos endpoint
app.get('/download-photos/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { albumNumber } = req.query;
    
    // Default to album 1 if not specified
    const album = albumNumber || 1;
    
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${address}-album${album}-photos.zip"`);
    archive.pipe(res);

    // Include album folder in the path
    const albumPath = `${folderName}/album${album}/`;
    const [files] = await bucket.getFiles({ prefix: albumPath });
    
    for (const file of files) {
      if (file.name !== albumPath) {
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

// ✅ /notify-print: INSTANT response with background processing (WITHOUT GOOGLE DRIVE)
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

        // Get the album number from the request
        const albumNumber = userDetails?.currentAlbumNumber || 1;
        
        // Include album folder in the path
        const folderPrefix = `${folderName}/album${albumNumber}/`;
        
        // Get files from this specific album folder
        const [files] = await bucket.getFiles({ prefix: folderPrefix });
        const totalPhotoCount = files.filter(file => file.name !== folderPrefix).length;

        // Background task 1: Upload to Dropbox only
        const uploadPromise = (async () => {
          try {
            console.log(`📦 Starting uploads for ${folderName}...`);
            
            // Calculate expected photo count (30 - remaining = photos taken)
            const expectedPhotoCount = 30 - photoCount;
            console.log(`⏳ Waiting for all ${expectedPhotoCount} photos to be uploaded to Firebase...`);
            
            // Wait until we have all expected photos in Firebase
            let attempts = 0;
            const maxAttempts = 60; // 60 attempts * 2 seconds = 2 minutes max wait
            let currentFiles = [];
            
            while (attempts < maxAttempts) {
              const [latestFiles] = await bucket.getFiles({ prefix: folderPrefix });
              currentFiles = latestFiles.filter(file => file.name !== folderPrefix);
              
              console.log(`🔍 Attempt ${attempts + 1}: Found ${currentFiles.length}/${expectedPhotoCount} photos in Firebase`);
              
              if (currentFiles.length >= expectedPhotoCount) {
                console.log(`✅ All ${expectedPhotoCount} photos found in Firebase!`);
                break;
              }
              
              attempts++;
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before checking again
            }
            
            if (currentFiles.length < expectedPhotoCount) {
              console.warn(`⚠️ Timeout: Only found ${currentFiles.length}/${expectedPhotoCount} photos after ${maxAttempts} attempts`);
            }
            
            const filesToUpload = currentFiles;
            console.log(`📁 Proceeding with ${filesToUpload.length} files to upload`);

            // Upload to Dropbox for each file
            for (let i = 0; i < filesToUpload.length; i++) {
              const file = filesToUpload[i];
              const filename = file.name.split('/').pop();
              
              console.log(`📤 Uploading ${i + 1}/${filesToUpload.length}: ${filename}`);
              
              // Upload to Dropbox (with retry logic)
              // Get album number from the notification data or default to 1
              const albumNumber = req.body?.userDetails?.currentAlbumNumber || 1;
              
              // Use the same filename format with album number, postcode, house number, and username
              // Extract user details from the notification data
              const postcode = req.body?.userDetails?.postcode || '';
              const houseNumber = req.body?.userDetails?.houseNumber || '';
              const username = req.body?.userDetails?.username || '';
              
              // The filename from Firebase already includes all the enhanced information
              const dropboxPath = `/30-clicks-import/${folderName}/album${albumNumber}/${filename}`;
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
            // Get album number from notification data
            const albumNumber = req.body?.userDetails?.currentAlbumNumber || 1;
            const albumText = `Album #${albumNumber}`;
            
            const emailSubject = skipToPrint 
              ? `⏩ PRINT REQUEST: ${address} (${albumText} - ${totalPhotoCount} photos - SKIPPED TO PRINT)`
              : `✅ PRINT REQUEST: ${address} (${albumText} - ${totalPhotoCount} photos - FULL ROLL)`;

            const emailHtml = `
              <h2>🖨️ New Print Request</h2>
              <p><strong>Address:</strong> ${address}</p>
              <p><strong>Album Number:</strong> ${albumNumber}</p>
              <p><strong>Total Photos:</strong> ${totalPhotoCount}</p>
              <p><strong>Photos Taken:</strong> ${actualPhotoCount}/30</p>
              <p><strong>Status:</strong> ${skipToPrint ? '⏩ Skipped to print' : '✅ Completed full roll'}</p>
              <h3>📥 Download Options:</h3>
              <div style="background-color: #e8f4fd; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <h4>Option 1: One-Click Download (Recommended)</h4>
                <p><a href="https://three0clicks.onrender.com/download-photos/${address}?albumNumber=${albumNumber}" style="background-color: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">📁 Download All Photos as ZIP</a></p>
              </div>
              <div style="background-color: #f0f0f0; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <h4>Option 2: Manual Download</h4>
                <p>1. Go to <a href="https://console.cloud.google.com/storage/browser/clicks-25b5a.firebasestorage.app/${folderName}/album${albumNumber}">Google Cloud Console</a></p>
                <p>2. Select all photos individually and download</p>
              </div>
              <div style="background-color: #e8f5e9; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <h4>Option 3: Dropbox (Auto-synced)</h4>
                <p>📁 Check your Dropbox: <code>/30-clicks-import/${folderName}/album${albumNumber}/</code></p>
                <p><small>Photos are automatically uploaded to Dropbox for your convenience. This may take 2-3 minutes to complete.</small></p>
              </div>
              <p><strong>User Details:</strong></p>
              <ul>
                <li><strong>Username:</strong> ${userDetails.username}</li>
                <li><strong>Postcode:</strong> ${userDetails.postcode}</li>
                <li><strong>House Number:</strong> ${userDetails.houseNumber}</li>
              </ul>
              <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
            `;

            await transport.sendMail({
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