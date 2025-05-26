const express = require('express');
const multer = require('multer');
const cors = require('cors');
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

// Manual review alert function for incomplete orders
async function sendManualReviewAlert(address, userDetails, actualCount, expectedCount) {
  try {
    const alertData = {
      timestamp: new Date().toISOString(),
      address: address,
      userDetails: userDetails,
      photosFound: actualCount,
      photosExpected: expectedCount,
      uploadSuccessRate: Math.round((actualCount / expectedCount) * 100),
      status: 'REQUIRES_MANUAL_REVIEW'
    };
    
    console.log('🚨 MANUAL REVIEW ALERT:', JSON.stringify(alertData, null, 2));
    console.log('📧 TODO: Implement email/notification system to alert admin of incomplete orders');
    console.log('📋 SUGGESTED ACTIONS:');
    console.log(`   1. Check Firebase Storage for folder: ${address}`);
    console.log(`   2. Verify user took ${expectedCount} photos vs ${actualCount} found`);
    console.log(`   3. Manually process partial order if appropriate`);
    console.log(`   4. Contact user if photos are permanently lost`);
    
    // TODO: Add actual notification system here
    // await emailAlert(alertData);
    // await slackAlert(alertData);
    // await databaseLog(alertData);
    
  } catch (error) {
    console.error('Error sending manual review alert:', error);
  }
}

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
      
      // Note: Address format depends on app version:
      // - Old app: "houseNumber_postcode" 
      // - New app: "email_houseNumber_postcode"
      // Backend accepts both formats automatically
      
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
      const email = req.query.email || username; // Use email if provided, fallback to username
      
      // Use the exact filename from the frontend (already contains photo ID)
      // This ensures consistency between frontend photo IDs and backend filenames
      let enhancedFilename = req.file.originalname;
      
      // If the filename doesn't contain the album number, add it for legacy support
      if (!enhancedFilename.includes(`album${albumNumber}_`)) {
        const timestamp = Date.now();
        // Backward compatibility: Check if email param exists (new app) vs old app
        const isNewAppVersion = req.query.email !== undefined;
        
        if (isNewAppVersion) {
          // New app version: include email in filename
          enhancedFilename = `album${albumNumber}_${postcode}_${houseNumber}_${email}_${username}_${timestamp}-${req.file.originalname}`;
        } else {
          // Old app version: use old filename format
          enhancedFilename = `album${albumNumber}_${postcode}_${houseNumber}_${username}_${timestamp}-${req.file.originalname}`;
        }
      }
      
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
        let folderPrefix = `${folderName}/album${albumNumber}/`;
        
        // Get files from this specific album folder
        // Try multiple folder formats for backward compatibility
        let files = [];
        let totalPhotoCount = 0;
        
        // Try current folder format first
        const [currentFiles] = await bucket.getFiles({ prefix: folderPrefix });
        files = currentFiles.filter(file => file.name !== folderPrefix);
        
        if (files.length === 0) {
          // If no files found, try legacy folder formats
          console.log(`🔍 No files found in ${folderPrefix}, trying legacy formats...`);
          
          // Extract user details to try different folder combinations
          const addressParts = address.split('_');
          
          if (addressParts.length >= 2) {
            // Try different legacy formats based on address parts
            const legacyFormats = [];
            
            if (addressParts.length === 2) {
              // Current format: "houseNumber_postcode" - try with street names
              const houseNumber = addressParts[0];
              const postcode = addressParts[1];
              
              // Look for folders that start with houseNumber and end with postcode
              const [allFiles] = await bucket.getFiles();
              const possibleFolders = allFiles
                .map(file => file.name.split('/')[0])
                .filter((folder, index, arr) => arr.indexOf(folder) === index) // unique folders
                .filter(folder => folder.startsWith(houseNumber) && folder.endsWith(postcode));
              
              console.log(`🔍 Found possible legacy folders:`, possibleFolders);
              
              for (const legacyFolder of possibleFolders) {
                const legacyPrefix = `${legacyFolder}/album${albumNumber}/`;
                const [legacyFiles] = await bucket.getFiles({ prefix: legacyPrefix });
                const legacyPhotoFiles = legacyFiles.filter(file => file.name !== legacyPrefix);
                
                if (legacyPhotoFiles.length > 0) {
                  console.log(`✅ Found ${legacyPhotoFiles.length} photos in legacy folder: ${legacyFolder}`);
                  files = legacyPhotoFiles;
                  // Update folderPrefix for the upload loop
                  folderPrefix = legacyPrefix;
                  break;
                }
              }
            }
          }
        }
        
        totalPhotoCount = files.length;
        console.log(`📁 Final folder: ${folderPrefix} with ${totalPhotoCount} photos`);

        // EXACT MATCH VERIFICATION: Wait until Firebase has exactly the number of photos taken
        const photosTaken = 10 - photoCount; // Counter tells us exactly how many photos user took
        console.log(`🎯 EXACT MATCH REQUIRED: User took ${photosTaken} photos, waiting for Firebase to contain exactly ${photosTaken} photos`);
        
        // Wait up to 60 minutes for all photos to upload (handles very poor connectivity and offline scenarios)
        const maxWaitMinutes = 60;
        let waitMinutes = 0;
        
        while (waitMinutes < maxWaitMinutes && totalPhotoCount < photosTaken) {
          if (waitMinutes === 0) {
            console.log(`⏳ STARTING VERIFICATION: Found ${totalPhotoCount}/${photosTaken} photos initially`);
          }
          
          // Wait 1 minute between checks
          await new Promise(resolve => setTimeout(resolve, 60000));
          waitMinutes++;
          
          // Re-check for photos in current folder
          const [retryFiles] = await bucket.getFiles({ prefix: folderPrefix });
          files = retryFiles.filter(file => file.name !== folderPrefix);
          totalPhotoCount = files.length;
          
          // Also check legacy folders if current folder has fewer photos
          if (totalPhotoCount < photosTaken) {
            const addressParts = address.split('_');
            if (addressParts.length === 2) {
              const houseNumber = addressParts[0];
              const postcode = addressParts[1];
              
              const [allFiles] = await bucket.getFiles();
              const possibleFolders = allFiles
                .map(file => file.name.split('/')[0])
                .filter((folder, index, arr) => arr.indexOf(folder) === index)
                .filter(folder => folder.startsWith(houseNumber) && folder.endsWith(postcode));
              
              for (const legacyFolder of possibleFolders) {
                const legacyPrefix = `${legacyFolder}/album${albumNumber}/`;
                const [legacyFiles] = await bucket.getFiles({ prefix: legacyPrefix });
                const legacyPhotoFiles = legacyFiles.filter(file => file.name !== legacyPrefix);
                
                if (legacyPhotoFiles.length > totalPhotoCount) {
                  console.log(`📁 Found ${legacyPhotoFiles.length} photos in legacy folder: ${legacyFolder}`);
                  files = legacyPhotoFiles;
                  folderPrefix = legacyPrefix;
                  totalPhotoCount = legacyPhotoFiles.length;
                  break;
                }
              }
            }
          }
          
          // Log progress every 5 minutes
          if (waitMinutes % 5 === 0) {
            console.log(`⏳ ${waitMinutes}min elapsed: Found ${totalPhotoCount}/${photosTaken} photos`);
          }
          
          // SUCCESS: Found exact number of photos
          if (totalPhotoCount >= photosTaken) {
            console.log(`✅ EXACT MATCH ACHIEVED: Found ${totalPhotoCount}/${photosTaken} photos after ${waitMinutes} minutes`);
            break;
          }
        }
        
        // Final verification
        if (totalPhotoCount < photosTaken) {
          console.log(`❌ VERIFICATION FAILED: Only found ${totalPhotoCount}/${photosTaken} photos after ${maxWaitMinutes} minutes`);
          console.log(`🚨 INCOMPLETE ORDER: User took ${photosTaken} photos but only ${totalPhotoCount} reached Firebase`);
          
          // Send manual review alert
          await sendManualReviewAlert(address, userDetails, totalPhotoCount, photosTaken);
          return; // Don't process incomplete orders
        }
        
        // EXACT MATCH CONFIRMED - proceed with processing
        console.log(`🎉 PROCEEDING TO PRINT: Confirmed ${totalPhotoCount} photos match ${photosTaken} photos taken`);

        // Background task 1: Upload to Dropbox only
        const uploadPromise = (async () => {
          try {
            console.log(`📦 Starting uploads for ${folderName}...`);
            
            // Use actual photo count instead of calculated expected count
            const actualPhotoCount = totalPhotoCount;
            console.log(`📊 Processing ${actualPhotoCount} photos found in Firebase...`);
            
            // Since we already found the photos, use them directly
            // No need to wait - photos are already confirmed to exist
            const filesToUpload = files;
            console.log(`✅ Using ${filesToUpload.length} photos already found in Firebase`);
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

        // Run upload task
        await uploadPromise;
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