async function checkPhoneOnInstagram(phone) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

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
    const found = body.includes('phone_number_is_taken') || body.includes('Another account is using');

    return {
      platform: 'instagram',
      found,
      method: 'phone',
      note: found ? 'Account registered with this phone' : 'No account found',
    };
  } catch {
    return { platform: 'instagram', found: false, method: 'phone', note: 'Could not check' };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { phone } = req.body || {};
    if (!phone || !phone.trim()) return res.status(400).json({ error: 'Phone required' });

    const results = await Promise.all([
      checkPhoneOnInstagram(phone.trim()),
    ]);

    const ig = results[0];
    results.push({
      platform: 'threads',
      found: ig.found,
      method: 'phone',
      note: ig.found ? 'Linked from Instagram (same Meta account)' : 'Threads uses Instagram login',
      inferredFromLink: ig.found,
      linkedFrom: ig.found ? 'instagram' : undefined,
    });

    results.push({ platform: 'facebook', found: false, method: 'phone', note: 'Phone lookup restricted', unsupported: true });
    results.push({ platform: 'twitter', found: false, method: 'phone', note: 'Phone lookup restricted', unsupported: true });
    results.push({ platform: 'tiktok', found: false, method: 'phone', note: 'Phone lookup not available', unsupported: true });

    return res.status(200).json({ query: phone.trim(), method: 'phone', results });
  } catch (err) {
    return res.status(500).json({ error: 'Phone lookup failed', message: err.message });
  }
};
