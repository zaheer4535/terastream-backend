const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── In-memory storage (replace with DB in production) ───────────────────────
let stats = { totalPlays: 0, totalUsers: 0, apiCalls: 0, errors: 0 };
let linkLogs = [];
let blockedIPs = [];
let adSettings = {
  enabled: true,
  beforeVideo: '<div style="text-align:center;padding:10px;background:#111;color:#FFC300;">Advertisement Space - Before Video</div>',
  insidePlayer: '',
  belowPlayer: '<div style="text-align:center;padding:10px;background:#111;color:#FFC300;">Advertisement Space - Below Player</div>',
};
app.get("/", (req, res) => {
  res.send("Server is working ✅");
});
let siteSettings = {
  siteName: 'TeraStream',
  accentColor: '#FFC300',
  rateLimit: 30,
  apiKey: 'sk_82289e8a832c75a8a835599f8efedc37',
};
let customPages = [];
let uniqueIPs = new Set();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));

// ─── IP Blocking Middleware ───────────────────────────────────────────────────
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (blockedIPs.includes(ip)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!uniqueIPs.has(ip)) {
    uniqueIPs.add(ip);
    stats.totalUsers = uniqueIPs.size;
  }
  next();
});

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => siteSettings.rateLimit,
  message: { error: 'Too many requests. Please wait a moment.' },
  keyGenerator: (req) => req.ip,
});

// ─── Admin Auth Middleware ─────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ─── Main API: Process TeraBox Link ──────────────────────────────────────────
app.post('/api/process', limiter, async (req, res) => {
  const { url } = req.body;
  const ip = req.ip;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  const sanitizedUrl = url.trim().substring(0, 2048);

  try {
    stats.apiCalls++;

    const response = await fetch('https://xapiverse.com/api/terabox', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xAPIverse-Key': siteSettings.apiKey,
      },
      body: JSON.stringify({ url: sanitizedUrl }),
    });

    // 🔥 DEBUG
    console.log("Status:", response.status);

    const text = await response.text();
    console.log("Raw response:", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({
        error: "Invalid JSON from API",
        raw: text
      });
    }

   // 🔹 Step 1: API fail
if (!response.ok) {
  return res.status(500).json({
    error: "API request failed",
    status: response.status
  });
}

// 🔹 Step 2: invalid response
if (!data || data.status !== "success") {
  return res.status(400).json({
    error: data?.message || "Invalid API response"
  });
}

// 🔹 Step 3: empty video list
if (!data.list || data.list.length === 0) {
  return res.status(404).json({
    error: "No video found in link"
  });
}

    const item = data.list[0];
    stats.totalPlays++;

    const result = {
      title: item.name || item.filename || 'Video',
      thumbnail: item.thumbnail || '',
      duration: item.duration || '',
      size: item.size || 0,
      streams: item.fast_stream_url || {},
      downloadUrl: item.normal_dlink || '',
    };

    linkLogs.unshift({
      id: Date.now(),
      url: sanitizedUrl,
      ip,
      time: new Date().toISOString(),
      status: 'success',
      title: result.title,
    });

    res.json(result);

  } catch (err) {
    console.error("API ERROR:", err);

    stats.errors++;

    linkLogs.unshift({
      id: Date.now(),
      url: sanitizedUrl,
      ip,
      time: new Date().toISOString(),
      status: 'error',
      error: err.message,
    });

    res.status(500).json({
      error: 'Server error',
      details: err.message
    });
  }
});

// ─── Admin Login ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ token: ADMIN_PASSWORD, success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// ─── Admin: Stats ─────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => {
  res.json({ ...stats, recentLogs: linkLogs.slice(0, 10) });
});

// ─── Admin: Logs ─────────────────────────────────────────────────────────────
app.get('/api/admin/logs', adminAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const start = (page - 1) * limit;
  res.json({
    logs: linkLogs.slice(start, start + limit),
    total: linkLogs.length,
    pages: Math.ceil(linkLogs.length / limit),
  });
});

// ─── Admin: Clear Logs ────────────────────────────────────────────────────────
app.delete('/api/admin/logs', adminAuth, (req, res) => {
  linkLogs = [];
  res.json({ success: true });
});

// ─── Admin: Ad Settings ───────────────────────────────────────────────────────
app.get('/api/admin/ads', adminAuth, (req, res) => res.json(adSettings));
app.put('/api/admin/ads', adminAuth, (req, res) => {
  adSettings = { ...adSettings, ...req.body };
  res.json(adSettings);
});

// ─── Admin: Site Settings ─────────────────────────────────────────────────────
app.get('/api/admin/settings', adminAuth, (req, res) => {
  const { apiKey, ...safeSettings } = siteSettings;
  res.json({ ...safeSettings, apiKeySet: !!apiKey });
});
app.put('/api/admin/settings', adminAuth, (req, res) => {
  siteSettings = { ...siteSettings, ...req.body };
  res.json({ success: true });
});

// ─── Admin: IP Management ─────────────────────────────────────────────────────
app.get('/api/admin/blocked-ips', adminAuth, (req, res) => res.json(blockedIPs));
app.post('/api/admin/blocked-ips', adminAuth, (req, res) => {
  const { ip } = req.body;
  if (ip && !blockedIPs.includes(ip)) blockedIPs.push(ip);
  res.json(blockedIPs);
});
app.delete('/api/admin/blocked-ips/:ip', adminAuth, (req, res) => {
  blockedIPs = blockedIPs.filter(i => i !== req.params.ip);
  res.json(blockedIPs);
});

// ─── Admin: Custom Pages ──────────────────────────────────────────────────────
app.get('/api/admin/pages', adminAuth, (req, res) => res.json(customPages));
app.post('/api/admin/pages', adminAuth, (req, res) => {
  const page = { id: Date.now(), ...req.body, createdAt: new Date().toISOString() };
  customPages.push(page);
  res.json(page);
});
app.put('/api/admin/pages/:id', adminAuth, (req, res) => {
  const idx = customPages.findIndex(p => p.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Page not found' });
  customPages[idx] = { ...customPages[idx], ...req.body };
  res.json(customPages[idx]);
});
app.delete('/api/admin/pages/:id', adminAuth, (req, res) => {
  customPages = customPages.filter(p => p.id != req.params.id);
  res.json({ success: true });
});

// ─── Public: Site Info ────────────────────────────────────────────────────────
app.get('/api/site-info', (req, res) => {
  res.json({ siteName: siteSettings.siteName, accentColor: siteSettings.accentColor });
});

// ─── Public: Custom Page ──────────────────────────────────────────────────────
app.get('/api/pages/:slug', (req, res) => {
  const page = customPages.find(p => p.slug === req.params.slug);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json(page);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
