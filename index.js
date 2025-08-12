
// index.js - Complete Mailchimp proxy server
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
require('dotenv').config();

// Initialization
const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

// Mailchimp configuration
let mailchimp;
try {
  mailchimp = require('@mailchimp/mailchimp_marketing');
  mailchimp.setConfig({
    apiKey: process.env.MAILCHIMP_API_KEY,
    server: process.env.MAILCHIMP_SERVER_PREFIX,
  });
} catch (error) {
  console.error('Error configuring Mailchimp:', error.message);
}

// Middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // maximum 100 requests per window
  message: {
    error: 'Too many requests, please try again later'
  }
});

app.use('/api/', limiter);

// Validation middleware
const validateMailchimpConfig = (req, res, next) => {
  if (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_SERVER_PREFIX) {
    return res.status(500).json({
      error: 'Incomplete Mailchimp configuration',
      message: 'MAILCHIMP_API_KEY and MAILCHIMP_SERVER_PREFIX are required'
    });
  }
  next();
};


app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});


app.get('/api/campaigns', validateMailchimpConfig, async (req, res) => {
  try {
    const cacheKey = 'mailchimp_campaigns';
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      return res.status(200).json(cachedData);
    }

    const {
      count = 5,
      status = 'sent',
      sortField = 'send_time',
      sortDir = 'DESC'
    } = req.query;

    const response = await mailchimp.campaigns.list({
      fields: [
        'campaigns.settings.subject_line',
        'campaigns.send_time',
        'campaigns.id',
        'campaigns.variate_settings.combinations',
        'campaigns.variate_settings.subject_lines',
      ],
      count: parseInt(count),
      status,
      sort_field: sortField,
      sort_dir: sortDir,
    });


    
    if (response && ('campaigns' in response )) {
      const campaigns = response.campaigns;
      cache.set(cacheKey, campaigns);
      res.status(200).json(campaigns);
    } else {
      console.log('No campaigns found in response structure');
      res.status(500).json({ error: 'Failed to fetch campaigns' });
    }

  } catch (error) {
    console.error('Error getting campaigns:', error);
    res.status(500).json({ error: 'error' });
  }
});

app.get('/api/campaigns/:campaignId', validateMailchimpConfig, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const cacheKey = `campaign_${campaignId}`;
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      return res.json({
        success: true,
        data: cachedData,
        cached: true
      });
    }

    const response = await mailchimp.campaigns.get(campaignId);
    const campaign = response;

    const processedCampaign = {
      id: campaign.id,
      subject: campaign.settings?.subject_line,
      sendTime: campaign.send_time,
      status: campaign.status,
      emailsSent: campaign.emails_sent,
      type: campaign.type,
      createTime: campaign.create_time,
      settings: {
        fromName: campaign.settings?.from_name,
        replyTo: campaign.settings?.reply_to,
        title: campaign.settings?.title
      }
    };

    cache.set(cacheKey, processedCampaign);

    res.json({
      success: true,
      data: processedCampaign,
      cached: false
    });

  } catch (error) {
    console.error('Error getting campaign:', error);
    if (error.status === 404) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found'
      });
    }
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get campaign content (HTML)
app.get('/api/campaigns/:campaignId/content', validateMailchimpConfig, async (req, res) => {
  try {
    const { campaignId } = req.params;
    
    if (!campaignId) {
      return res.status(400).json({
        success: false,
        error: 'Missing campaignId parameter'
      });
    }

    const cacheKey = `campaign_content_${campaignId}`;
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      return res.json({
        success: true,
        data: cachedData,
        cached: true
      });
    }

    const response = await mailchimp.campaigns.getContent(campaignId);
    
    const responseData = response;
    if (responseData && responseData.html) {
      const content = responseData.html;
      cache.set(cacheKey, content);
      
      res.json({
        success: true,
        data: content,
        cached: false
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Invalid response from Mailchimp - no HTML content found'
      });
    }

  } catch (error) {
    console.error('Error getting campaign content:', error);
    
    if (error.status === 404) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Error getting campaign content',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});


app.get('/api/audience/stats', validateMailchimpConfig, async (req, res) => {
  try {
    const cacheKey = 'audience_stats';
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      return res.json({
        success: true,
        data: cachedData,
        cached: true
      });
    }

    const response = await mailchimp.lists.getAllLists();
    const responseData =  response;
    const lists = responseData.lists || [];

    const stats = lists.map(list => ({
      id: list.id,
      name: list.name,
      memberCount: list.stats?.member_count || 0,
      subscribedCount: list.stats?.member_count_since_send || 0,
      unsubscribedCount: list.stats?.unsubscribe_count || 0,
      dateCreated: list.date_created
    }));

    cache.set(cacheKey, stats);

    res.json({
      success: true,
      data: stats,
      cached: false
    });

  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting statistics'
    });
  }
});

// Subscribe email to newsletter
app.post('/api/newsletter/subscribe', validateMailchimpConfig, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed'
    });
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required'
      });
    }

    if (!process.env.MAILCHIMP_AUDIENCE_ID) {
      return res.status(500).json({
        success: false,
        message: 'Newsletter audience ID not configured'
      });
    }

    const response = await mailchimp.lists.addListMember(process.env.MAILCHIMP_AUDIENCE_ID, {
      email_address: email,
      status: 'pending',
    });

    console.log(`response: ${response}`);

    // Respond to the client
    res.status(200).json({
      success: true,
      message: 'Form submitted successfully! Please confirm your email',
    });

  } catch (error) {
    console.error('Error adding to list:', error);

    if (error.status === 400 && error.response?.body?.title === 'Member Exists') {
      res.status(500).json({
        success: false,
        message: 'Email already subscribed.',
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'An error occurred while processing your request.',
      });
    }
  }
});


app.post('/api/cache/clear', (req, res) => {
  const { key } = req.body;
  
  if (key) {
    cache.del(key);
    res.json({
      success: true,
      message: `Cache '${key}' deleted`
    });
  } else {
    cache.flushAll();
    res.json({
      success: true,
      message: 'All cache deleted'
    });
  }
});

app.get('/api/cache/info', (req, res) => {
  const keys = cache.keys();
  const stats = cache.getStats();
  
  res.json({
    success: true,
    data: {
      keys: keys,
      stats: stats,
      keysCount: keys.length
    }
  });
});


app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableRoutes: [
      'GET /health',
      'GET /api/campaigns',
      'GET /api/campaigns/:id',
      'GET /api/campaigns/:id/content',
      'GET /api/audience/stats',
      'POST /api/newsletter/subscribe',
      'POST /api/cache/clear',
      'GET /api/cache/info'
    ]
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});


const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Server health: http://localhost:${PORT}/health`);
  console.log(`📧 Mailchimp API: http://localhost:${PORT}/api/campaigns`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed correctly');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed correctly');
    process.exit(0);
  });
});

module.exports = app;