import { makeToken } from './_lib.js';
export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { password } = await req.json();
  if (!process.env.APP_PASSWORD || password !== process.env.APP_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Password salah' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  const token = await makeToken();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30*24*3600}`
    }
  });
}
