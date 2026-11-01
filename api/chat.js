import { kv } from '@vercel/kv';
import { requireAuth } from './_lib.js';
export const config = { runtime: 'edge' };

const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1'
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, options);
    if (res.status === 503 && i < maxRetries - 1) await new Promise(r => setTimeout(r, 2000));
    else return res;
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!(await requireAuth(req))) return json({ error: 'Unauthorized' }, 401);

  const { provider, model, messages, tools } = await req.json();
  const baseUrl = BASE_URLS[provider];
  if (!baseUrl) return json({ error: 'Provider tidak dikenal' }, 400);

  const keys = (await kv.hgetall('apikeys')) || {};
  const apiKey = keys[provider];
  if (!apiKey) return json({ error: `API key ${provider} belum diset.` }, 400);

  const memory = (await kv.get('memory')) || [];
  const memBlock = memory.length ? '\n\n=== MEMORY ===\n' + memory.map(m => '- ' + m.text).join('\n') : '';
  const sysIdx = messages.findIndex(m => m.role === 'system');
  if (sysIdx >= 0) messages[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + memBlock };
  else messages.unshift({ role: 'system', content: 'Kamu adalah AI agent.' + memBlock });

  const rememberTool = { type: 'function', function: { name: 'remember', description: 'Simpan fakta user', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } };
  const allTools = [...(tools || []), rememberTool];

  let upstream, text, respHeaders = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });

  if (provider === 'anthropic') {
    const sysMsg = messages.find(m => m.role === 'system')?.content || '';
    const anthropicMsgs = messages.filter(m => m.role !== 'system').map(m => {
      if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
      
      let finalContent = m.content;
      if (Array.isArray(m.content)) {
        finalContent = [];
        m.content.forEach(c => {
          if (c.type === 'text') finalContent.push({ type: 'text', text: c.text });
          if (c.type === 'image_url') {
             const match = c.image_url.url.match(/^data:(image\/[a-z]+);base64,(.+)$/);
             if (match) finalContent.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
          }
        });
      }
      
      if (m.role === 'assistant' && m.tool_calls) {
        const content = []; if (m.content) content.push({ type: 'text', text: m.content });
        m.tool_calls.forEach(tc => content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) }));
        return { role: 'assistant', content };
      }
      return { role: m.role, content: finalContent };
    });
    
    const anthropicTools = allTools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
    upstream = await fetchWithRetry(`${baseUrl}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4096, system: sysMsg, messages: anthropicMsgs, tools: anthropicTools.length ? anthropicTools : undefined })
    });
    const rawText = await upstream.text();
    if (!upstream.ok) return new Response(rawText, { status: upstream.status, headers: respHeaders });
    const data = JSON.parse(rawText);
    let content = '', tool_calls = undefined;
    if (data.content) data.content.forEach(c => {
      if (c.type === 'text') content += c.text;
      if (c.type === 'tool_use') { if (!tool_calls) tool_calls = []; tool_calls.push({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }); }
    });
    text = JSON.stringify({ choices: [{ message: { role: 'assistant', content, tool_calls } }], usage: { total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) } });

  } else if (provider === 'gemini') {
    const sysMsg = messages.find(m => m.role === 'system')?.content || '';
    const geminiMsgs = [];
    let lastToolNames = {};
    
    messages.filter(m => m.role !== 'system').forEach(m => {
      if (m.role === 'assistant') {
        if (m.tool_calls) {
          m.tool_calls.forEach(tc => { lastToolNames[tc.id] = tc.function.name; });
          const parts = [];
          if (m.content) parts.push({ text: m.content });
          m.tool_calls.forEach(tc => {
            const partObj = { functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') } };
            if (tc.thought_signature) partObj.thoughtSignature = tc.thought_signature;
            parts.push(partObj);
          });
          geminiMsgs.push({ role: 'model', parts });
        } else {
          geminiMsgs.push({ role: 'model', parts: [{ text: m.content || '' }] });
        }
      } else if (m.role === 'tool') {
        const toolName = lastToolNames[m.tool_call_id] || 'search_internet';
        geminiMsgs.push({ role: 'user', parts: [{ functionResponse: { name: toolName, response: { content: m.content } } }] });
      } else {
        let parts = [];
        if (Array.isArray(m.content)) {
           m.content.forEach(c => {
             if (c.type === 'text') parts.push({ text: c.text });
             if (c.type === 'image_url') {
                const match = c.image_url.url.match(/^data:(image\/[a-z]+);base64,(.+)$/);
                if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
             }
           });
        } else {
           parts.push({ text: m.content || '' });
        }
        geminiMsgs.push({ role: 'user', parts });
      }
    });

    const geminiTools = allTools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));

    upstream = await fetchWithRetry(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        system_instruction: { parts: [{ text: sysMsg }] }, 
        contents: geminiMsgs,
        tools: geminiTools.length ? [{ function_declarations: geminiTools }] : undefined
      })
    });

    const rawText = await upstream.text();
    if (!upstream.ok) return new Response(rawText, { status: upstream.status, headers: respHeaders });
    const data = JSON.parse(rawText);
    const part = data.candidates?.[0]?.content?.parts?.[0];
    
    let content = part?.text || '';
    let tool_calls = undefined;
    
    if (part?.functionCall) {
      const tcObj = {
        id: 'call_' + Date.now(),
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) }
      };
      if (part.thoughtSignature) tcObj.thought_signature = part.thoughtSignature;
      tool_calls = [tcObj];
    }
    
    text = JSON.stringify({ 
      choices: [{ message: { role: 'assistant', content, tool_calls } }], 
      usage: { total_tokens: (data.usageMetadata?.promptTokenCount || 0) + (data.usageMetadata?.candidatesTokenCount || 0) } 
    });

  } else {
    // OpenAI, DeepSeek, OpenRouter, Groq (Support native Vision via Array)
    upstream = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
  if (respStatus === 401) respStatus = 400; 
  return new Response(text, { status: respStatus, headers: respHeaders });
}
