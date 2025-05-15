const fetch = require('node-fetch');
const { bucket } = require('./firebase-config');

// Dropbox Token Manager
class DropboxTokenManager {
  constructor() {
    this.accessToken = process.env.DROPBOX_TOKEN; // Using your existing env var name
    this.refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
    this.appKey = process.env.DROPBOX_APP_KEY;
    this.appSecret = process.env.DROPBOX_APP_SECRET;
    this.lastRefresh = 0;
    this.refreshTimeout = 3.5 * 60 * 60 * 1000; // 3.5 hours in milliseconds
  }

  async refreshAccessToken() {
    try {
      console.log('🔄 Refreshing Dropbox access token...');
      
      const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: this.appKey,
          client_secret: this.appSecret,
        }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
      }

      if (data.access_token) {
        this.accessToken = data.access_token;
        process.env.DROPBOX_TOKEN = data.access_token; // Update your existing env var
        this.lastRefresh = Date.now();
        
        console.log('✅ Dropbox access token refreshed successfully');
        return data.access_token;
      }
      
      throw new Error('No access token in response');
    } catch (error) {
      console.error('❌ Failed to refresh Dropbox token:', error);
      throw error;
    }
  }

  async getValidAccessToken() {
    // Check if token needs refresh (every 3.5 hours)
    const timeSinceRefresh = Date.now() - this.lastRefresh;
    
    if (timeSinceRefresh > this.refreshTimeout || !this.accessToken) {
      await this.refreshAccessToken();
    }
    
    return this.accessToken;
  }
}

// Initialize token manager
const dropboxAuth = new DropboxTokenManager();

async function uploadToDropboxFromFirebase(filePath, dropboxPath) {
  try {
    // Get fresh access token
    const token = await dropboxAuth.getValidAccessToken();
    
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
      const errorText = await response.text();
      let errorDetails;
      
      try {
        errorDetails = JSON.parse(errorText);
      } catch (e) {
        errorDetails = { error_summary: errorText };
      }
      
      console.error('Dropbox upload failed:', errorDetails);
      
      // Check if it's a rate limit error
      if (errorDetails.error_summary && errorDetails.error_summary.includes('too_many_write_operations')) {
        const retryAfter = errorDetails.error?.retry_after || 1;
        console.log(`⚠️ Rate limited. Retry suggested after ${retryAfter}s`);
        
        // Throw a special error that includes retry info
        const rateLimitError = new Error('Rate limited by Dropbox');
        rateLimitError.isRateLimit = true;
        rateLimitError.retryAfter = retryAfter * 1000; // Convert to milliseconds
        throw rateLimitError;
      }
      
      throw new Error(`Failed to upload to Dropbox: ${response.status} ${errorDetails.error_summary || errorText}`);
    }

    console.log('✅ Uploaded to Dropbox:', dropboxPath);
    return await response.json();
  } catch (error) {
    // Re-throw with additional context
    if (error.isRateLimit) {
      throw error; // Preserve rate limit info
    }
    
    console.error('❌ Dropbox upload error:', error);
    throw error;
  }
}

// Enhanced upload function with built-in retry logic
async function uploadToDropboxWithRetry(filePath, dropboxPath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await uploadToDropboxFromFirebase(filePath, dropboxPath);
    } catch (error) {
      console.log(`Upload attempt ${attempt}/${maxRetries} failed for ${dropboxPath}`);
      
      if (attempt < maxRetries) {
        let delay = 2000; // Default 2 second delay
        
        // If it's a rate limit error, use the suggested retry time
        if (error.isRateLimit && error.retryAfter) {
          delay = Math.max(error.retryAfter, 1000); // At least 1 second
          console.log(`Rate limited. Waiting ${delay/1000}s before retry...`);
        } else {
          // Exponential backoff for other errors
          delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          console.log(`Waiting ${delay/1000}s before retry...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`Failed to upload to Dropbox after ${maxRetries} attempts:`, error.message);
        throw error;
      }
    }
  }
}

// Export the token manager for use in index.js
module.exports = { 
  uploadToDropboxFromFirebase,
  uploadToDropboxWithRetry,
  dropboxAuth
};