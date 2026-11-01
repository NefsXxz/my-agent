import { kv } from '@vercel/kv';
import { requireAuth } from './_lib.js';
export const config = { runtime: 'edge' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default async function handler(req) {
  if (!(await requireAuth(req))) return json({ error: 'Unauthorized' }, 401);

  if (req.method === 'GET') {
    const mem = (await kv.get('memory')) || [];
    return json(mem);
  }

  if (req.method === 'POST') {
    const { text } = await req.json();
    if (!text || !text.trim()) return json({ error: 'Teks wajib' }, 400);
    const mem = (await kv.get('memory')) || [];
    const fact = {
      id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      text: text.trim(),
      createdAt: Date.now()
    };
    mem.push(fact);
    await kv.set('memory', mem.slice(-200));
    return json(fact);
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (id === 'all') {
      await kv.set('memory', []);
    } else if (id) {
      const mem = (await kv.get('memory')) || [];
      await kv.set('memory', mem.filter(m => m.id !== id));
    } else {
      return json({ error: 'ID wajib' }, 400);
    }
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
