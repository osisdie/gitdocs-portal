// /api/* (Cloudflare Pages Functions catch-all). Routing and handlers live in functions/_lib/api.js.
import { handleApi } from '../_lib/api.js';

export const onRequest = (ctx) => handleApi(ctx);
