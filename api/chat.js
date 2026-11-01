import { kv } from '@vercel/kv';
import { requireAuth } from './_lib.js';
export const config = { runtime: 'edge' };

const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1'
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!(await requireAuth(req))) return json({ error: 'Unauthorized' }, 401);

  const { provider, model, messages, tools } = await req.json();
  const baseUrl = BASE_URLS[provider];
  if (!baseUrl) return json({ error: 'Provider tidak dikenal' }, 400);

  const keys = (await kv.hgetall('apikeys')) || {};
  const apiKey = keys[provider];
  if (!apiKey) return json({ error: `API key ${provider} belum diset. Buka ⚙️ Keys.` }, 400);

  // === INJECT MEMORY KE SYSTEM PROMPT ===
  const memory = (await kv.get('memory')) || [];
  const memBlock = memory.length
    ? '\n\n=== MEMORY (fakta tentang user dari percakapan sebelumnya) ===\n' +
      memory.map(m => '- ' + m.text).join('\n') +
      '\n\nGunakan memori ini bila relevan. Untuk menyimpan fakta baru tentang user, panggil tool `remember`.'
    : '';

  const sysIdx = messages.findIndex(m => m.role === 'system');
  if (sysIdx >= 0) {
    messages[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + memBlock };
  } else {
    messages.unshift({ role: 'system', content: 'Kamu adalah AI agent yang membantu user.' + memBlock });
  }

  // === TAMBAH TOOL `remember` DI SERVER ===
  const rememberTool = {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Simpan fakta penting tentang user untuk diingat di percakapan mendatang. Gunakan saat user menyebut preferensi, info personal, atau konteks yang berguna jangka panjang. JANGAN simpan hal sepele atau sementara.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Fakta singkat, satu kalimat, dari sudut pandangmu. Contoh: "User tinggal di Jakarta dan bekerja sebagai desainer."'
          }
        },
        required: ['text']
      }
    }
  };

  const allTools = [...(tools || []), rememberTool];
  const body = { model, messages, stream: false, tools: allTools };

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });

  const text = await upstream.text();

  let respStatus = upstream.status;
if (respStatus === 401) respStatus = 400;

  // === FORWARD QUOTA HEADER GROQ KE FRONTEND ===
  const respHeaders = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  });
  if (provider === 'groq') {
    const rem = upstream.headers.get('x-ratelimit-remaining-tokens');
    const lim = upstream.headers.get('x-ratelimit-limit-tokens');
    if (rem) respHeaders.set('X-Agent-Quota-Remaining', rem);
    if (lim) respHeaders.set('X-Agent-Quota-Limit', lim);
  }

  return new Response(text, { status: respStatus, headers: respHeaders });
}
