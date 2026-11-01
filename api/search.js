export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { query } = await req.json();
  
  try {
    // 1. Coba pakai Tavily
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tavily-Access-Mode': 'keyless' },
      body: JSON.stringify({ query, max_results: 5 })
    });
    
    if (res.ok) {
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    }

    // 2. Kalau Tavily gagal/limit, pakai DuckDuckGo (Gratis tanpa API Key)
    const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await ddgRes.text();
    
    const results = [];
    const regex = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>[\s\S]*?<a class="result__snippet" href="[^"]+">(.*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 5) {
      results.push({
        title: match[2].replace(/<[^>]+>/g, ''),
        url: match[1],
        content: match[3].replace(/<[^>]+>/g, '').trim()
      });
    }
    
    if (results.length > 0) {
      return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
    }
    
    throw new Error('Pencarian gagal di semua server.');
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
