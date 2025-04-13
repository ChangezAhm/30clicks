const multer = require('multer');
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = 5500;

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: true,
  preflightContinue: true
}));

app.use(express.json());

// Ensure uploads directory exists
const uploadDir = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Create folder endpoint
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
    const folderName = address.replace(/[^a-z0-9]/gi, '_');
    const userDir = path.join(uploadDir, folderName);
    fs.mkdirSync(userDir, { recursive: true });

    console.log('Created folder:', userDir);
    res.json({
      success: true,
      message: 'Folder created successfully',
      path: folderName
    });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create folder',
      details: error.message
    });
  }
});

// Configure storage for uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      const { address } = req.query;
      if (!address) return cb(new Error('Address is required'), null);

      const folderName = address.replace(/[^a-z0-9]/gi, '_');
      const userDir = path.join(uploadDir, folderName);
      fs.mkdirSync(userDir, { recursive: true });

      cb(null, userDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const uniqueFilename = `${timestamp}-${file.originalname}`;
    console.log('Creating file:', uniqueFilename);
    cb(null, uniqueFilename);
  }
});

const upload = multer({
  storage: storage,
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

// Upload endpoint
app.post('/upload', (req, res) => {
  console.log('Upload request received', req.query);

  upload(req, res, (err) => {
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

    console.log('File uploaded successfully:', req.file.path);
    res.json({
      success: true,
      message: 'Image uploaded successfully',
      filePath: req.file.path,
      fileSize: req.file.size,
      timestamp: new Date().toISOString()
    });
  });
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
}));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// Start server on 0.0.0.0 so it's reachable on local network
app.listen(PORT, '0.0.0.0', () => {
  console.log('=================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Access it from your device at:`);
  console.log(`→ http://localhost:${PORT}`);
  console.log(`→ http://<YOUR_LOCAL_IP>:${PORT}`);
  console.log(`📁 Upload directory: ${uploadDir}`);
  console.log('=================================');
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