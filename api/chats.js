import { kv } from '@vercel/kv';
import { requireAuth } from './_lib.js';
export const config = { runtime: 'edge' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default async function handler(req) {
  if (!(await requireAuth(req))) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  // GET: list chat (atau detail kalau ada ?id=)
  if (req.method === 'GET') {
    if (id) {
      const chat = await kv.get(`chat:${id}`);
      if (!chat) return json({ error: 'Chat tidak ditemukan' }, 404);
      return json(chat);
    }
    const list = (await kv.get('chatlist')) || [];
    return json(list);
  }

  // POST: buat chat baru
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const title = body.title || 'Chat Baru';
    const newId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    const chat = { id: newId, title, createdAt: now, updatedAt: now, messages: [] };
    await kv.set(`chat:${newId}`, chat);
    const list = (await kv.get('chatlist')) || [];
    list.unshift({ id: newId, title, createdAt: now, updatedAt: now });
    await kv.set('chatlist', list.slice(0, 100));
    return json(chat);
  }

  // PUT: update chat (messages + title)
  if (req.method === 'PUT') {
    if (!id) return json({ error: 'ID wajib' }, 400);
    const body = await req.json();
    const chat = await kv.get(`chat:${id}`);
    if (!chat) return json({ error: 'Chat tidak ditemukan' }, 404);

    if (Array.isArray(body.messages)) {
      chat.messages = body.messages.length > 200
        ? body.messages.slice(-200)
        : body.messages;
    }
    if (typeof body.title === 'string' && body.title.trim()) {
      chat.title = body.title.trim();
    }
    chat.updatedAt = Date.now();
    await kv.set(`chat:${id}`, chat);

    const list = (await kv.get('chatlist')) || [];
    const i = list.findIndex(c => c.id === id);
    if (i >= 0) {
      list[i].title = chat.title;
      list[i].updatedAt = chat.updatedAt;
      const [item] = list.splice(i, 1);
      list.unshift(item);
      await kv.set('chatlist', list);
    }
    return json({ ok: true });
  }

  // DELETE: hapus chat
  if (req.method === 'DELETE') {
    if (!id) return json({ error: 'ID wajib' }, 400);
    await kv.del(`chat:${id}`);
    const list = (await kv.get('chatlist')) || [];
    await kv.set('chatlist', list.filter(c => c.id !== id));
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
