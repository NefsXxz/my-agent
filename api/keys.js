import { kv } from '@vercel/kv';
import { requireAuth } from './_lib.js';
export const config = { runtime: 'edge' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default async function handler(req) {
  if (!(await requireAuth(req))) return json({ error: 'Unauthorized' }, 401);

  if (req.method === 'GET') {
    const keys = (await kv.hgetall('apikeys')) || {};
    const masked = {};
    for (const [p, k] of Object.entries(keys)) {
      masked[p] = k ? k.slice(0, 6) + '•••' + k.slice(-4) : '';
    }
    return json(masked);
  }

  if (req.method === 'POST') {
    const { provider, key } = await req.json();
    if (!provider || !key) return json({ error: 'Data kurang' }, 400);
    await kv.hset('apikeys', { [provider]: key });
    return json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { provider } = await req.json();
    await kv.hdel('apikeys', provider);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
