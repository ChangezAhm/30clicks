const fetch = require('node-fetch');
const { bucket } = require('./firebase-config');

// Robust Dropbox Token Manager with graceful degradation
class DropboxTokenManager {
  constructor() {
    this.accessToken = process.env.DROPBOX_TOKEN;
    this.refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
    this.appKey = process.env.DROPBOX_APP_KEY;
    this.appSecret = process.env.DROPBOX_APP_SECRET;
    this.lastRefresh = 0;
    this.refreshTimeout = 3.5 * 60 * 60 * 1000; // 3.5 hours in milliseconds
    this.isDegradedMode = false;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3;
  }

  async refreshAccessToken(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Token refresh attempt ${attempt}/${maxRetries}`);
        
        // Add timeout to prevent infinite hang
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          console.log('⏰ Token refresh timeout - aborting request');
          controller.abort();
        }, 10000); // 10 second timeout
        
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
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data.access_token) {
          throw new Error('No access token in response');
        }
        
        // SUCCESS - reset failure tracking
        this.accessToken = data.access_token;
        process.env.DROPBOX_TOKEN = data.access_token;
        this.lastRefresh = Date.now();
        this.consecutiveFailures = 0;
        this.isDegradedMode = false;
        
        console.log('✅ Dropbox access token refreshed successfully');
        return data.access_token;
        
      } catch (error) {
        console.warn(`❌ Token refresh attempt ${attempt} failed:`, error.message);
        
        if (attempt === maxRetries) {
          // All retries failed - enter graceful degradation
          console.error('🚨 All token refresh attempts failed - entering degraded mode');
          return this.handleTokenRefreshFailure(error);
        }
        
        // Wait before retry (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  async handleTokenRefreshFailure(lastError) {
    this.consecutiveFailures++;
    
    console.log(`🛡️ Token refresh failed ${this.consecutiveFailures} times - implementing fallback strategy`);
    
    // Send alert to admin for manual intervention
    await this.alertAdmin('Dropbox token refresh failed', {
      error: lastError.message,
      consecutiveFailures: this.consecutiveFailures,
      timestamp: new Date().toISOString(),
      lastRefresh: new Date(this.lastRefresh).toISOString()
    });
    
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      console.log('🔌 Entering degraded mode - Dropbox uploads will be skipped');
      this.isDegradedMode = true;
    }
    
    // Return existing token (may be expired) to continue processing
    if (this.accessToken) {
      console.log('📋 Using existing token (may be expired) to attempt continued operation');
      return this.accessToken;
    }
    
    // No token available - return null to skip Dropbox operations
    console.log('🚫 No token available - Dropbox operations will be skipped');
    return null;
  }
  
  async alertAdmin(message, details = {}) {
    try {
      // Log comprehensive alert information
      console.log('🚨 ADMIN ALERT:', message);
      console.log('📋 Alert Details:', JSON.stringify(details, null, 2));
      
      // TODO: Implement actual notification system
      // Examples:
      // - Send email to admin
      // - Post to Slack channel
      // - Write to monitoring dashboard
      // - Send SMS for critical failures
      
      console.log('📧 TODO: Implement email/Slack notification to admin');
      console.log('🔧 MANUAL ACTION REQUIRED: Check Dropbox API status and token configuration');
    } catch (error) {
      console.error('Failed to send admin alert:', error);
    }
  }

  async getValidAccessToken() {
    // Check if we're in degraded mode
    if (this.isDegradedMode) {
      console.log('⚠️ In degraded mode - skipping token refresh, using existing token');
      return this.accessToken; // May be expired, but we'll try anyway
    }
    
    // Check if token needs refresh (every 3.5 hours)
    const timeSinceRefresh = Date.now() - this.lastRefresh;
    
    if (timeSinceRefresh > this.refreshTimeout || !this.accessToken) {
      const token = await this.refreshAccessToken();
      return token; // May be null if refresh failed
    }
    
    return this.accessToken;
  }
  
  // Method to check if Dropbox operations should be attempted
  shouldAttemptDropboxOperation() {
    if (this.isDegradedMode) {
      console.log('🔌 Degraded mode active - skipping Dropbox operation');
      return false;
    }
    return true;
  }
  
  // Method to manually exit degraded mode (for recovery)
  exitDegradedMode() {
    console.log('🔄 Manually exiting degraded mode - will attempt token refresh on next operation');
    this.isDegradedMode = false;
    this.consecutiveFailures = 0;
  }
}

// Initialize token manager
const dropboxAuth = new DropboxTokenManager();

// Sanitize filename for Dropbox API (remove special characters that cause HTTP header issues)
function sanitizeDropboxPath(path) {
  return path
    .replace(/['"'']/g, '') // Remove apostrophes and quotes
    .replace(/%[0-9A-F]{2}/gi, '') // Remove URL encoded characters
    .replace(/[^\w\s\-_./]/g, '_') // Replace other special chars with underscore
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_'); // Replace multiple underscores with single
}

async function uploadToDropboxFromFirebase(filePath, dropboxPath) {
  try {
    // Check if Dropbox operations should be attempted
    if (!dropboxAuth.shouldAttemptDropboxOperation()) {
      console.log('📦 Skipping Dropbox upload due to degraded mode');
      return { skipped: true, reason: 'degraded_mode' };
    }
    
    // Get fresh access token
    const token = await dropboxAuth.getValidAccessToken();
    
    // If token is null, skip Dropbox upload
    if (!token) {
      console.log('📦 No valid token available - skipping Dropbox upload');
      return { skipped: true, reason: 'no_token' };
    }
    
    // Sanitize the dropbox path to avoid HTTP header issues
    const sanitizedDropboxPath = sanitizeDropboxPath(dropboxPath);
    console.log('🧹 Sanitized path:', dropboxPath, '→', sanitizedDropboxPath);
    
    const file = bucket.file(filePath);
    const [buffer] = await file.download();
    
    // Add timeout to file upload to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('⏰ Dropbox upload timeout - aborting request');
      controller.abort();
    }, 30000); // 30 second timeout for file uploads

    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: sanitizedDropboxPath,
          mode: 'add',
          autorename: true,
          mute: false
        })
      },
      body: buffer,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

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

    console.log('✅ Uploaded to Dropbox:', sanitizedDropboxPath);
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