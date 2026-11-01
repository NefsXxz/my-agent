export function b64url(bytes) {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}

export async function makeToken(ttlMs = 30 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  const sig = await hmac(String(exp), process.env.SESSION_SECRET);
  return `${exp}.${sig}`;
}

export async function verifyToken(token) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig) return false;
  const expected = await hmac(exp, process.env.SESSION_SECRET);
  if (sig !== expected) return false;
  if (Date.now() > parseInt(exp)) return false;
  return true;
}

export async function requireAuth(req) {
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? await verifyToken(match[1]) : false;
}
