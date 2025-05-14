const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const archiver = require('archiver');
const { bucket } = require('./firebase-config');
const { uploadToDropboxFromFirebase } = require('./dropbox-utils');

const app = express();
const PORT = process.env.PORT || 5500;

// CORS configuration (keeping your existing code)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: true,
  preflightContinue: true
}));

app.use(express.json());

// Configure email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Set up multer for memory storage (instead of disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  }
}).single('image');

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Upload endpoint - now uploads to Firebase
app.post('/upload', (req, res) => {
  console.log('Upload request received', req.query);

  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).json({
        success: false,
        error: 'Upload failed',
        details: err.message
      });
    }

    if (!req.file) {
      console.log('No file in request');
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    try {
      const { address } = req.query;
      if (!address) {
        return res.status(400).json({
          success: false,
          error: 'Address is required'
        });
      }

      // Create a safe folder name from the address
      const folderName = address.replace(/[^a-z0-9]/gi, '_');
      
      // Create a unique filename
      const timestamp = Date.now();
      const filename = `${timestamp}-${req.file.originalname}`;
      const filePath = `${folderName}/${filename}`;
      
      // Create a file reference in Firebase
      const fileRef = bucket.file(filePath);
      
      // Upload the file to Firebase
      const stream = fileRef.createWriteStream({
        metadata: {
          contentType: req.file.mimetype
        }
      });
      
      // Handle upload errors
      stream.on('error', (error) => {
        console.error('Upload to Firebase failed:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to upload to cloud storage',
          details: error.message
        });
      });
      
      // Handle upload success
      stream.on('finish', async () => {
        // Make the file publicly accessible
        await fileRef.makePublic();
        
        // Get the public URL
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        
        console.log('File uploaded successfully to Firebase:', publicUrl);
        res.json({
          success: true,
          message: 'Image uploaded successfully',
          fileUrl: publicUrl,
          timestamp: new Date().toISOString()
        });
      });
      
      // Send the file to Firebase
      stream.end(req.file.buffer);
      
    } catch (error) {
      console.error('Server error during upload:', error);
      res.status(500).json({
        success: false,
        error: 'Server error',
        details: error.message
      });
    }
  });
});

// Add the create-folder endpoint for backward compatibility
app.post('/upload/create-folder', (req, res) => {
  console.log('Create folder request received', req.query);
  const { address } = req.query;

  if (!address) {
    return res.status(400).json({
      success: false,
      error: 'Address is required'
    });
  }

  try {
    // With Firebase, folders are created automatically when files are uploaded
    // We don't need to explicitly create them, so we just return success
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    console.log('Folder for Firebase will be created automatically:', folderName);
    
    res.json({
      success: true,
      message: 'Folder will be created automatically on first upload',
      path: folderName
    });
  } catch (error) {
    console.error('Error processing folder request:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process folder request',
      details: error.message
    });
  }
});

// Download photos endpoint - creates a ZIP file of all photos in a folder
app.get('/download-photos/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    
    console.log(`Creating download for folder: ${folderName}`);
    
    // Create a zip archive
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${address}-photos.zip"`);
    
    // Pipe archive to response
    archive.pipe(res);
    
    // Get all files in the folder
    const [files] = await bucket.getFiles({ prefix: folderName + '/' });
    
    console.log(`Found ${files.length} files in folder ${folderName}`);
    
    // Add each file to the archive
    for (const file of files) {
      if (file.name !== folderName + '/') { // Skip the folder itself
        const stream = file.createReadStream();
        const fileName = file.name.split('/').pop();
        archive.append(stream, { name: fileName });
      }
    }
    
    // Finalize the archive
    archive.finalize();
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: 'Failed to create download', 
      details: error.message 
    });
  }
});

// Add print notification endpoint
app.post('/notify-print', async (req, res) => {
  try {
    const { address, photoCount, userDetails, skipToPrint } = req.body;
    
    console.log('Print notification received:', { address, photoCount, skipToPrint });
    
    const actualPhotoCount = 30 - photoCount;
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    
    // Send email notification
    const emailSubject = skipToPrint 
      ? `⏩ PRINT REQUEST: ${address} (${actualPhotoCount} photos - SKIPPED TO PRINT)`
      : `✅ PRINT REQUEST: ${address} (${actualPhotoCount} photos - FULL ROLL)`;
    
    const emailHtml = `
      <h2>🖨️ New Print Request</h2>
      <p><strong>Address:</strong> ${address}</p>
      <p><strong>Photos taken:</strong> ${actualPhotoCount}/30</p>
      <p><strong>Status:</strong> ${skipToPrint ? '⏩ Skipped to print' : '✅ Completed full roll'}</p>
      
      <h3>📥 Download Options:</h3>
      <div style="background-color: #e8f4fd; padding: 15px; margin: 20px 0; border-radius: 5px;">
        <h4>Option 1: One-Click Download (Recommended)</h4>
        <p>
          <a href="https://three0clicks.onrender.com/download-photos/${address}" 
             style="background-color: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            📁 Download All Photos as ZIP
          </a>
        </p>
      </div>
      
      <div style="background-color: #f0f0f0; padding: 15px; margin: 20px 0; border-radius: 5px;">
        <h4>Option 2: Manual Download</h4>
        <p>1. Go to <a href="https://console.cloud.google.com/storage/browser/clicks-25b5a.firebasestorage.app/${folderName}">Google Cloud Console</a></p>
        <p>2. Select all photos individually and download</p>
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
    
    console.log('Print notification email sent successfully');
    
    res.json({
      success: true,
      message: 'Print notification sent'
    });
  } catch (error) {
    console.error('Error sending print notification:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send notification',
      details: error.message
    });
  }
});

// Global error handler (keeping your existing code)
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// Start server (keeping your existing code)
app.listen(PORT, '0.0.0.0', () => {
  console.log('=================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Access it from your device at:`);
  console.log(`→ http://localhost:${PORT}`);
  console.log(`→ http://<YOUR_LOCAL_IP>:${PORT}`);
  console.log('=================================');
});

// Graceful shutdown (keeping your existing code)
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down...');
  process.exit(0);
});