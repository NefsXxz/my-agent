import { kv } from '@vercel/kv';
import { requireAuth } from './_lib.js';
export const config = { runtime: 'edge' };

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

export default async function handler(req) {
  if (!(await requireAuth(req))) return json({ error: 'Unauthorized' }, 401);

  const provider = new URL(req.url).searchParams.get('provider');

  if (provider === 'openrouter') {
    const keys = (await kv.hgetall('apikeys')) || {};
    const key = keys.openrouter;
    if (!key) return json({ error: 'OpenRouter key belum diset' }, 400);

    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return json({ error: 'Gagal ambil kuota OpenRouter' }, 502);

    const data = await r.json();
    return json({
      limit_remaining: data.data?.limit_remaining ?? null,
      usage: data.data?.usage ?? null,
      limit: data.data?.limit ?? null
    });
  }

  if (provider === 'groq') return json({ note: 'Groq quota from chat headers' });
  return json({ error: 'Provider tidak didukung' }, 400);
}
