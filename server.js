const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- In-memory cache ---
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  // Evict old entries if cache grows too large (keep under 10k entries)
  if (cache.size > 10000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < 1000; i++) {
      cache.delete(oldest[i][0]);
    }
  }
}

// --- Platform configs ---
const PLATFORMS = {
  instagram: {
    name: 'Instagram',
    url: 'https://www.instagram.com/{username}/',
    check: 'https://www.instagram.com/{username}/',
    owner: 'meta',
  },
  tiktok: {
    name: 'TikTok',
    url: 'https://www.tiktok.com/@{username}',
    check: 'https://www.tiktok.com/@{username}',
    owner: 'bytedance',
  },
  twitter: {
    name: 'X / Twitter',
    url: 'https://x.com/{username}',
    check: 'https://x.com/{username}',
    owner: 'x',
  },
  facebook: {
    name: 'Facebook',
    url: 'https://www.facebook.com/{username}',
    check: 'https://www.facebook.com/{username}',
    owner: 'meta',
  },
  threads: {
    name: 'Threads',
    url: 'https://www.threads.net/@{username}',
    check: 'https://www.threads.net/@{username}',
    owner: 'meta',
  },
};

const LINKED_PLATFORMS = {
  instagram: ['threads'],
};

// --- Google dork fallback ---
async function googleDorkCheck(platform, username) {
  const siteMap = {
    instagram: 'instagram.com',
    tiktok: 'tiktok.com',
    twitter: 'x.com',
    facebook: 'facebook.com',
    threads: 'threads.net',
  };

  const site = siteMap[platform];
  if (!site) return null;

  const query = encodeURIComponent(`site:${site} "${username}"`);
  const googleUrl = `https://www.google.com/search?q=${query}&num=5`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(googleUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timeout);
    const body = await response.text();

    const hasResult = body.includes(site + '/') && body.toLowerCase().includes(username.toLowerCase());

    // Try to extract the actual profile URL from Google results
    let profileUrl = null;
    const urlRegex = new RegExp(`https?://(www\\.)?${site.replace('.', '\\.')}[^"\\s<>]*${username}[^"\\s<>]*`, 'i');
    const match = body.match(urlRegex);
    if (match) {
      profileUrl = match[0];
    }

    return { found: hasResult, profileUrl, method: 'google' };
  } catch (err) {
    return null;
  }
}

// --- Direct profile check ---
async function checkProfileDirect(platform, username) {
  const config = PLATFORMS[platform];
  if (!config) return { platform, username, found: false, url: null };

  const url = config.check.replace('{username}', username);
  const profileUrl = config.url.replace('{username}', username);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timeout);

    const status = response.status;
    const body = await response.text();

    let found = false;

    if (status === 200) {
      if (platform === 'instagram') {
        found = !body.includes('Sorry, this page') && !body.includes('Page Not Found');
      } else if (platform === 'tiktok') {
        found = !body.includes("Couldn't find this account") && !body.includes('This account');
      } else if (platform === 'twitter') {
        found = !body.includes('This account doesn') && !body.includes('Account suspended') && status !== 404;
      } else if (platform === 'facebook') {
        found = !body.includes('Page Not Found') && !body.includes("content isn't available");
      } else if (platform === 'threads') {
        found = !body.includes('Sorry, this page') && !body.includes('Page Not Found');
      } else {
        found = true;
      }
    }

    if (status >= 300 && status < 400) {
      found = true;
    }

    return { platform, username, found, url: profileUrl, status, method: 'direct' };
  } catch (err) {
    return { platform, username, found: false, url: profileUrl, error: err.message, method: 'direct' };
  }
}

// --- Combined check: direct first, Google fallback ---
async function checkProfile(platform, username) {
  const cacheKey = `profile:${platform}:${username}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  // Try direct check first
  let result = await checkProfileDirect(platform, username);

  // If direct check failed (error or blocked), try Google dork
  if (!result.found && (result.error || result.status === 429 || result.status === 403)) {
    const googleResult = await googleDorkCheck(platform, username);
    if (googleResult && googleResult.found) {
      result = {
        platform,
        username,
        found: true,
        url: googleResult.profileUrl || PLATFORMS[platform].url.replace('{username}', username),
        method: 'google',
      };
    }
  }

  setCache(cacheKey, result);
  return result;
}

// --- Email checks ---
async function checkEmailOnInstagram(email) {
  const cacheKey = `email:instagram:${email}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://www.instagram.com/accounts/web_create_ajax/attempt/', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-CSRFToken': 'missing',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.instagram.com/accounts/emailsignup/',
      },
      body: `email=${encodeURIComponent(email)}`,
    });

    clearTimeout(timeout);
    const body = await response.text();
    const emailTaken = body.includes('email_is_taken') || body.includes('Another account is using');

    const result = {
      platform: 'instagram',
      found: emailTaken,
      method: 'email',
      url: null,
      note: emailTaken ? 'An account is registered with this email' : 'No account found with this email',
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    return { platform: 'instagram', found: false, method: 'email', error: err.message };
  }
}

async function checkPhoneOnInstagram(phone) {
  const cacheKey = `phone:instagram:${phone}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://www.instagram.com/accounts/web_create_ajax/attempt/', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-CSRFToken': 'missing',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.instagram.com/accounts/emailsignup/',
      },
      body: `phone_number=${encodeURIComponent(phone)}`,
    });

    clearTimeout(timeout);
    const body = await response.text();
    const phoneTaken = body.includes('phone_number_is_taken') || body.includes('Another account is using');

    const result = {
      platform: 'instagram',
      found: phoneTaken,
      method: 'phone',
      url: null,
      note: phoneTaken ? 'An account is registered with this phone' : 'No account found with this phone',
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    return { platform: 'instagram', found: false, method: 'phone', error: err.message };
  }
}

async function checkEmailOnFacebook(email) {
  const cacheKey = `email:facebook:${email}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://www.facebook.com/recover/initiate/?ars=facebook_login', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.facebook.com/login/identify/',
      },
      body: `email=${encodeURIComponent(email)}`,
      redirect: 'manual',
    });

    clearTimeout(timeout);
    const status = response.status;
    const location = response.headers.get('location') || '';
    const found = status === 302 && !location.includes('login_attempt');

    const result = {
      platform: 'facebook',
      found,
      method: 'email',
      url: null,
      note: found ? 'An account may be registered with this email' : 'No account found with this email',
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    return { platform: 'facebook', found: false, method: 'email', error: err.message };
  }
}

async function checkEmailOnTwitter(email) {
  const cacheKey = `email:twitter:${email}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(`https://api.twitter.com/i/users/email_available.json?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      },
    });

    clearTimeout(timeout);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { platform: 'twitter', found: false, method: 'email', url: null, note: 'Could not check (blocked)' };
    }
    const found = data.taken === true;

    const result = {
      platform: 'twitter',
      found,
      method: 'email',
      url: null,
      note: found ? 'An account is registered with this email' : 'No account found with this email',
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    return { platform: 'twitter', found: false, method: 'email', note: 'Could not check' };
  }
}

// --- API Routes ---

// Username lookup
app.post('/api/lookup', async (req, res) => {
  const { username, platforms: requestedPlatforms } = req.body;

  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const clean = username.trim().replace(/^@/, '').toLowerCase();
  const platformsToCheck = requestedPlatforms || Object.keys(PLATFORMS);

  const results = await Promise.all(
    platformsToCheck.map(platform => checkProfile(platform, clean))
  );

  // Cross-platform linking: if IG found, confirm Threads
  const igResult = results.find(r => r.platform === 'instagram' && r.found);
  if (igResult) {
    const threadsResult = results.find(r => r.platform === 'threads');
    if (threadsResult) {
      threadsResult.linkedFrom = 'instagram';
      threadsResult.linkNote = 'Threads uses your Instagram handle — same person';
      if (!threadsResult.found) {
        threadsResult.found = true;
        threadsResult.inferredFromLink = true;
      }
    }
  }

  res.json({ query: clean, results });
});

// Name variations lookup
app.post('/api/lookup-variations', async (req, res) => {
  const { name, platforms: requestedPlatforms } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const parts = name.trim().toLowerCase().split(/\s+/);
  const variations = new Set();

  variations.add(parts.join(''));
  variations.add(parts.join('.'));
  variations.add(parts.join('_'));

  if (parts.length > 1) {
    variations.add(parts[0] + parts[parts.length - 1]);
    variations.add(parts[parts.length - 1] + parts[0]);
    variations.add(parts[0] + '.' + parts[parts.length - 1]);
    variations.add(parts[0] + '_' + parts[parts.length - 1]);
    variations.add(parts[0][0] + parts[parts.length - 1]);
  }

  const platformsToCheck = requestedPlatforms || Object.keys(PLATFORMS);
  const allResults = {};

  for (const variation of variations) {
    const results = await Promise.all(
      platformsToCheck.map(platform => checkProfile(platform, variation))
    );
    allResults[variation] = results;
  }

  res.json({
    query: name.trim(),
    variations: [...variations],
    results: allResults,
  });
});

// Email lookup
app.post('/api/lookup-email', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const results = await Promise.all([
    checkEmailOnInstagram(email.trim()),
    checkEmailOnFacebook(email.trim()),
    checkEmailOnTwitter(email.trim()),
  ]);

  const igResult = results.find(r => r.platform === 'instagram' && r.found);
  if (igResult) {
    results.push({
      platform: 'threads',
      found: true,
      method: 'email',
      url: null,
      note: 'Likely registered (Threads uses Instagram account)',
      inferredFromLink: true,
      linkedFrom: 'instagram',
    });
  } else {
    results.push({
      platform: 'threads',
      found: false,
      method: 'email',
      url: null,
      note: 'Cannot check directly — Threads uses Instagram login',
    });
  }

  results.push({
    platform: 'tiktok',
    found: false,
    method: 'email',
    url: null,
    note: 'TikTok does not expose email lookup publicly',
    unsupported: true,
  });

  res.json({ query: email.trim(), method: 'email', results });
});

// Phone lookup
app.post('/api/lookup-phone', async (req, res) => {
  const { phone } = req.body;

  if (!phone || !phone.trim()) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  const results = await Promise.all([
    checkPhoneOnInstagram(phone.trim()),
  ]);

  if (results[0] && results[0].found) {
    results.push({
      platform: 'threads',
      found: true,
      method: 'phone',
      url: null,
      note: 'Likely registered (Threads uses Instagram account)',
      inferredFromLink: true,
      linkedFrom: 'instagram',
    });
  }

  results.push({ platform: 'facebook', found: false, method: 'phone', url: null, note: 'Facebook phone lookup restricted', unsupported: true });
  results.push({ platform: 'twitter', found: false, method: 'phone', url: null, note: 'X/Twitter phone lookup restricted', unsupported: true });
  results.push({ platform: 'tiktok', found: false, method: 'phone', url: null, note: 'TikTok does not expose phone lookup publicly', unsupported: true });

  res.json({ query: phone.trim(), method: 'phone', results });
});

// Cache stats (for monitoring)
app.get('/api/cache-stats', (req, res) => {
  res.json({
    entries: cache.size,
    maxEntries: 10000,
    ttlHours: 24,
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SocialTrace server running at http://localhost:${PORT}`);
  console.log(`Cache TTL: 24 hours | Max entries: 10,000`);
});
