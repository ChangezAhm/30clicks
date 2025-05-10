const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { bucket } = require('./firebase-config');

const app = express();
const PORT = 5500;

// CORS configuration (keeping your existing code)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: true,
  preflightContinue: true
}));

app.use(express.json());

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

// We don't need the create-folder endpoint anymore, as folders are automatically created in Firebase

// We don't need to serve files from the server anymore as Firebase handles this

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