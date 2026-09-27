import { handleAI, aiStatus } from './live-ai.mjs';
export const RELEASE = '2026-09-27-motion-performance';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      'X-TeamCreator-Release': RELEASE,
    };
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
    if (url.pathname.startsWith('/api/ai/')) {
      const result = await handleAI(request, env);
      for (const [key, value] of Object.entries(headers)) result.headers.set(key, value);
      return result;
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, release: RELEASE, mode: 'browser-local', storage: 'visitor-browser', remote_ai: aiStatus(env).configured });
    }
    if (url.pathname === '/api/provider' && request.method === 'GET') {
      return json({ provider: 'none', status: 'unavailable', mode: 'degraded', model: null, shell_tools: false, web_search: false,
        message: 'AI public neconfigurat. Datele și simularea funcționează în browser.' });
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Acest demo păstrează proiectele în browser. Serverul public nu acceptă fișiere sau comenzi de model.' }, 404);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    if ((response.headers.get('Content-Type') || '').includes('text/html')) response.headers.set('Cache-Control', 'no-cache');
    return response;
  },
};
