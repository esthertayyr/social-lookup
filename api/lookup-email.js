async function checkEmailOnInstagram(email) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

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
    const found = body.includes('email_is_taken') || body.includes('Another account is using');

    return {
      platform: 'instagram',
      found,
      method: 'email',
      note: found ? 'Account registered with this email' : 'No account found',
    };
  } catch {
    return { platform: 'instagram', found: false, method: 'email', note: 'Could not check' };
  }
}

async function checkEmailOnTwitter(email) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(`https://api.twitter.com/i/users/email_available.json?email=${encodeURIComponent(email)}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      },
    });
    clearTimeout(timeout);

    const data = await response.json();
    return {
      platform: 'twitter',
      found: data.taken === true,
      method: 'email',
      note: data.taken ? 'Account registered with this email' : 'No account found',
    };
  } catch {
    return { platform: 'twitter', found: false, method: 'email', note: 'Could not check' };
  }
}

async function checkEmailOnFacebook(email) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

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

    const location = response.headers.get('location') || '';
    const found = response.status === 302 && !location.includes('login_attempt');

    return {
      platform: 'facebook',
      found,
      method: 'email',
      note: found ? 'Account may be registered with this email' : 'No account found',
    };
  } catch {
    return { platform: 'facebook', found: false, method: 'email', note: 'Could not check' };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { email } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email required' });

  const results = await Promise.all([
    checkEmailOnInstagram(email.trim()),
    checkEmailOnTwitter(email.trim()),
    checkEmailOnFacebook(email.trim()),
  ]);

  // IG → Threads linking
  const ig = results.find(r => r.platform === 'instagram' && r.found);
  results.push({
    platform: 'threads',
    found: !!ig,
    method: 'email',
    note: ig ? 'Linked from Instagram (same Meta account)' : 'Threads uses Instagram login',
    inferredFromLink: !!ig,
    linkedFrom: ig ? 'instagram' : undefined,
  });

  results.push({
    platform: 'tiktok',
    found: false,
    method: 'email',
    note: 'TikTok does not expose email lookup',
    unsupported: true,
  });

  res.status(200).json({ query: email.trim(), method: 'email', results });
};
