// Runs before every request in server mode (Cloudflare Pages Functions). See functions/_lib/gate.js.
import { gate } from './_lib/gate.js';
import { errorJson } from './_lib/http.js';

export async function onRequest(ctx) {
  try {
    return await gate(ctx);
  } catch (e) {
    console.error('middleware', e);
    return errorJson(500, 'server error');
  }
}
