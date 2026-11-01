import { kv } from '@vercel/kv';
import { requireAuth } from './_lib.js';
export const config = { runtime: 'edge' };

const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  anthropic: 'https://api.anthropic.com/v1' // Tambahan Claude
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
    ? '\n\n=== MEMORY (fakta tentang user) ===\n' +
      memory.map(m => '- ' + m.text).join('\n') +
      '\n\nGunakan memori ini bila relevan. Untuk menyimpan fakta baru tentang user, panggil tool `remember`.'
    : '';

  const sysIdx = messages.findIndex(m => m.role === 'system');
  if (sysIdx >= 0) {
    messages[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + memBlock };
  } else {
    messages.unshift({ role: 'system', content: 'Kamu adalah AI agent.' + memBlock });
  }

  // === TAMBAH TOOL `remember` ===
  const rememberTool = {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Simpan fakta penting tentang user untuk diingat.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Fakta singkat.' }
        },
        required: ['text']
      }
    }
  };
  const allTools = [...(tools || []), rememberTool];

  let upstream, text, respHeaders = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });

  // === KONDISI KHUSUS ANTHROPIC (CLAUDE) ===
  if (provider === 'anthropic') {
    const sysMsg = messages.find(m => m.role === 'system')?.content || '';
    const anthropicMsgs = messages.filter(m => m.role !== 'system').map(m => {
      if (m.role === 'tool') {
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        m.tool_calls.forEach(tc => content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) }));
        return { role: 'assistant', content };
      }
      return { role: m.role, content: m.content };
    });

    const anthropicTools = allTools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));

    upstream = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4096,
        system: sysMsg,
        messages: anthropicMsgs,
        tools: anthropicTools.length ? anthropicTools : undefined
      })
    });

    const rawText = await upstream.text();
    if (!upstream.ok) return new Response(rawText, { status: upstream.status, headers: respHeaders });
    
    // Konversi balik ke format OpenAI biar frontend kita gak perlu ubah apa-apa
    const data = JSON.parse(rawText);
    let content = '';
    let tool_calls = undefined;

    if (data.content) {
      data.content.forEach(c => {
        if (c.type === 'text') content += c.text;
        if (c.type === 'tool_use') {
          if (!tool_calls) tool_calls = [];
          tool_calls.push({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.input) }
          });
        }
      });
    }
    
    text = JSON.stringify({
      choices: [{ message: { role: 'assistant', content, tool_calls } }],
      usage: { total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) }
    });

  } else {
    // === PROVIDER OPENAI, OPENROUTER, GROQ ===
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools: allTools })
    });
    text = await upstream.text();
    if (provider === 'groq') {
      const rem = upstream.headers.get('x-ratelimit-remaining-tokens');
      const lim = upstream.headers.get('x-ratelimit-limit-tokens');
      if (rem) respHeaders.set('X-Agent-Quota-Remaining', rem);
      if (lim) respHeaders.set('X-Agent-Quota-Limit', lim);
    }
  }

  let respStatus = upstream.status;
  if (respStatus === 401) respStatus = 400; // Biar gak munculin layar login terus

  return new Response(text, { status: respStatus, headers: respHeaders });
}
