/**
 * backend/server.ts
 *
 * http server: json api under /api plus the built frontend for everything else
 */

import { join } from './src/fs.ts';
import { authEnabled, isAuthorized } from './src/api/auth.ts';
import { createApiRouter, errorResponse } from './src/api/routes.ts';
import { json } from './src/api/router.ts';
import { env, frontendDir } from './src/config.ts';

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
};

const withCors = (response: Response): Response => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
    return response;
};

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * without a token the browser is all that keeps other sites away from the api, so it only answers its own pages:
 * another Origin is a cross-site request, another Host is a dns name rebound to this machine.
 * gives the reason a request is refused, or null when it is the hub's own
 */
const foreignRequest = (request: Request, url: URL): string | null => {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== url.origin) return 'requests from another origin need API_TOKEN to be set';
    // an operator who chose the address to listen on also chose who can reach it, under whatever name
    if (!env.explicitHost() && !LOOPBACK_HOST.test(url.hostname)) return 'without API_TOKEN the hub only answers on localhost';
    return null;
};

const CONTENT_TYPES: Record<string, string> = {
    js: 'text/javascript; charset=utf-8',
    map: 'application/json',
    css: 'text/css; charset=utf-8',
    html: 'text/html; charset=utf-8',
    png: 'image/png',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    webmanifest: 'application/manifest+json',
    xml: 'application/xml',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
};

/**
 * serves a file from the frontend directory; paths are normalised so nothing outside it can be reached
 */
const serveStatic = async (pathname: string): Promise<Response> => {
    try {
        // inside the try: a malformed percent-escape makes decodeURIComponent throw, and that is just another missing file
        const segments = decodeURIComponent(pathname).split('/').filter((segment) => segment && segment !== '.');
        if (segments.some((segment) => segment === '..')) return new Response('not found', { status: 404 });

        const file = await Deno.open(join(frontendDir, ...segments), { read: true });
        const stat = await file.stat();
        if (!stat.isFile) {
            file.close();
            return new Response('not found', { status: 404 });
        }
        const extension = segments.at(-1)?.split('.').pop()?.toLowerCase() ?? '';
        return new Response(file.readable, {
            headers: {
                'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
                'content-length': String(stat.size),
                // the bundle and styles change on every build, so make browsers revalidate them
                'cache-control': 'no-cache',
            },
        });
    } catch {
        return new Response('not found', { status: 404 });
    }
};

export const createHandler = (): Deno.ServeHandler => {
    const api = createApiRouter();

    return async (request) => {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/api')) {
            // the debugger websocket is opened by chrome devtools too, and the random token in its path is the credential
            const tokenInPath = url.pathname.startsWith('/api/debug/ws/');
            // with a token any page may call the api (the frontend's api base url setting); without one only the hub's own pages
            const open = !authEnabled() && !tokenInPath;
            const respond = open ? (response: Response) => response : withCors;
            if (open) {
                const refused = foreignRequest(request, url);
                if (refused) return json({ error: refused }, 403);
            }

            if (request.method === 'OPTIONS') return respond(new Response(null, { status: 204 }));
            if (url.pathname !== '/api/health' && !tokenInPath && !isAuthorized(request)) {
                return respond(json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' }));
            }

            const matched = api.match(request);
            if (matched === null) return respond(json({ error: 'not found' }, 404));
            if (matched instanceof Response) return respond(matched);

            try {
                return respond(await matched.handler(request, matched.params));
            } catch (error) {
                return respond(errorResponse(error));
            }
        }

        // frontend: only the built bundle, static assets, and the entry page are exposed
        if (url.pathname.startsWith('/dist/') || url.pathname.startsWith('/static/')) {
            return serveStatic(url.pathname);
        }

        if (url.pathname === '/' || url.pathname === '/index.html') {
            try {
                const html = await Deno.readTextFile(join(frontendDir, 'index.html'));
                return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
            } catch {
                return new Response('frontend not built yet: run `deno task build`', { status: 503 });
            }
        }

        return new Response('not found', { status: 404 });
    };
};

export const startServer = (port = env.port()): Deno.HttpServer => {
    return Deno.serve({
        port,
        hostname: env.host(),
        onListen: ({ hostname, port }) => {
            const address = hostname === '0.0.0.0' ? 'localhost' : hostname.includes(':') ? `[${hostname}]` : hostname;
            const auth = env.apiToken() ? 'auth enabled' : 'auth disabled: only answers its own pages';
            console.log(`puzzle hub listening on http://${address}:${port} (${auth})`);
        },
    }, createHandler());
};

if (import.meta.main) {
    startServer();
}
