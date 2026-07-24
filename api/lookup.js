const PLATFORMS = {
  instagram: {
    name: 'Instagram',
    url: 'https://www.instagram.com/{username}/',
    check: 'https://www.instagram.com/{username}/',
  },
  tiktok: {
    name: 'TikTok',
    url: 'https://www.tiktok.com/@{username}',
    check: 'https://www.tiktok.com/@{username}',
  },
  twitter: {
    name: 'X / Twitter',
    url: 'https://x.com/{username}',
    check: 'https://x.com/{username}',
  },
  facebook: {
    name: 'Facebook',
    url: 'https://www.facebook.com/{username}',
    check: 'https://www.facebook.com/{username}',
  },
  threads: {
    name: 'Threads',
    url: 'https://www.threads.net/@{username}',
    check: 'https://www.threads.net/@{username}',
  },
};

// Simple in-memory cache (persists across warm serverless invocations)
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 5000) {
    const keys = [...cache.keys()];
    for (let i = 0; i < 500; i++) cache.delete(keys[i]);
  }
}

async function googleFallback(platform, username) {
  const sites = {
    instagram: 'instagram.com',
    tiktok: 'tiktok.com',
    twitter: 'x.com',
    facebook: 'facebook.com',
    threads: 'threads.net',
  };
  const site = sites[platform];
  if (!site) return null;

  try {
    const q = encodeURIComponent(`site:${site} "${username}"`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(`https://www.google.com/search?q=${q}&num=3`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    const body = await res.text();
    const found = body.includes(site + '/') && body.toLowerCase().includes(username.toLowerCase());
    return found ? { found: true, method: 'google' } : null;
  } catch {
    return null;
  }
}

async function checkProfile(platform, username) {
  const cacheKey = `${platform}:${username}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const config = PLATFORMS[platform];
  const profileUrl = config.url.replace('{username}', username);
  const checkUrl = config.check.replace('{username}', username);

  let result;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(checkUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    const status = response.status;
    const body = await response.text();
    let found = false;

    if (status === 200) {
      if (platform === 'instagram') found = !body.includes('Sorry, this page') && !body.includes('Page Not Found');
      else if (platform === 'tiktok') found = !body.includes("Couldn't find this account");
      else if (platform === 'twitter') found = !body.includes('This account doesn') && !body.includes('Account suspended');
      else if (platform === 'facebook') found = !body.includes('Page Not Found') && !body.includes("content isn't available");
      else if (platform === 'threads') found = !body.includes('Sorry, this page') && !body.includes('Page Not Found');
      else found = true;
    }
    if (status >= 300 && status < 400) found = true;

    result = { platform, username, found, url: profileUrl, method: 'direct' };

    // Google fallback if blocked
    if (!found && (status === 429 || status === 403 || status === 0)) {
      const g = await googleFallback(platform, username);
      if (g && g.found) {
        result = { platform, username, found: true, url: profileUrl, method: 'google' };
      }
    }
  } catch (err) {
    // Direct failed, try Google
    const g = await googleFallback(platform, username);
    if (g && g.found) {
      result = { platform, username, found: true, url: profileUrl, method: 'google' };
    } else {
      result = { platform, username, found: false, url: profileUrl, method: 'direct', error: 'timeout' };
    }
  }

  setCache(cacheKey, result);
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { username, platforms } = req.body;
  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username required' });
  }

  const clean = username.trim().replace(/^@/, '').toLowerCase();
  const toCheck = platforms || Object.keys(PLATFORMS);

  const results = await Promise.all(toCheck.map(p => checkProfile(p, clean)));

  // IG → Threads linking
  const ig = results.find(r => r.platform === 'instagram' && r.found);
  if (ig) {
    const th = results.find(r => r.platform === 'threads');
    if (th) {
      if (!th.found) { th.found = true; th.inferredFromLink = true; }
      th.linkedFrom = 'instagram';
      th.linkNote = 'Same person as Instagram (both Meta)';
    }
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.status(200).json({ query: clean, results });
};
