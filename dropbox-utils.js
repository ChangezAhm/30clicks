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
      const err = await response.text();
      console.error('Dropbox upload failed:', err);
      throw new Error('Failed to upload to Dropbox');
    }

    console.log('✅ Uploaded to Dropbox:', dropboxPath);
    return await response.json();
  } catch (error) {
    console.error('❌ Dropbox upload error:', error);
    throw error;
  }
}

// Export the token manager for use in index.js
module.exports = { 
  uploadToDropboxFromFirebase,
  dropboxAuth
};