import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import * as registry from './registry.js';

// Leader-elected aggregating hub.
//
// stdio MCP spawns one process per agent session, and each process runs its own
// backend ViewerServer on an ephemeral port. Whichever process wins the bind on
// the fixed hub port (7682) becomes the hub: it serves the single public URL,
// aggregates `/sessions` from every registered backend, and WS-proxies `/ws` to
// the backend that actually owns the PTY. Non-leaders retry on an interval so if
// the hub process dies another takes over within a few seconds (self-healing).
//
// Browser ⇄ hub uses the hub token; hub ⇄ backend uses each backend's own token
// from the registry, so backends with differing tokens still aggregate cleanly.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

interface Owner {
  port: number;
  token: string;
}

export class HubServer {
  private readonly token: string;
  private readonly port: number;
  private readonly enabled: boolean;
  private viewerDir: string;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private healTimer?: NodeJS.Timeout;
  private owners = new Map<string, Owner>();
  private isHub = false;
  private binding = false;

  constructor(token: string) {
    this.token = token;
    this.port = parseInt(process.env.ISH_HUB_PORT || '7682', 10);
    this.enabled = process.env.ISH_VIEWER_DISABLE !== '1';
    this.viewerDir = path.join(__dirname, '..', 'viewer');
  }

  tryStart(): void {
    if (!this.enabled) return;
    this.attempt();
    const healMs = parseInt(process.env.ISH_HUB_HEAL_MS || '5000', 10) || 5000;
    this.healTimer = setInterval(() => {
      if (!this.isHub) this.attempt();
    }, healMs);
    // Don't keep the process alive just for the heal probe.
    this.healTimer.unref?.();
  }

  stop(): void {
    if (this.healTimer) {
      clearInterval(this.healTimer);
      this.healTimer = undefined;
    }
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.isHub = false;
  }

  private attempt(): void {
    if (this.isHub || this.binding) return;
    this.binding = true;

    const server = http.createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket as Duplex, head);
    });

    // Fires on EADDRINUSE (another process is the hub) and on later runtime
    // socket errors. Either way we relinquish so the heal interval re-attempts.
    server.once('error', (err: NodeJS.ErrnoException) => {
      this.binding = false;
      this.isHub = false;
      if (err.code !== 'EADDRINUSE') {
        console.error('[hub] socket error:', err.message);
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
    });

    server.listen(this.port, '127.0.0.1', () => {
      this.binding = false;
      this.isHub = true;
      this.server = server;
      this.wss = wss;
      this.writeViewerUrl();
      console.error(`[hub] aggregating viewer at http://127.0.0.1:${this.port}/?token=${this.token}`);
      server.on('close', () => {
        this.isHub = false;
        this.server = undefined;
      });
    });
  }

  private writeViewerUrl(): void {
    try {
      const url = `http://127.0.0.1:${this.port}/?token=${this.token}`;
      fs.writeFileSync(path.join(__dirname, '..', 'viewer-url.txt'), url + '\n');
    } catch {
      /* best-effort */
    }
  }

  // ----------------------------------------------------------------- HTTP

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const u = new URL(req.url || '/', 'http://127.0.0.1');

    // xterm vendor assets are harmless library files — served without a token.
    if (u.pathname.startsWith('/vendor/')) {
      this.serveStatic(path.join(this.viewerDir, u.pathname), res);
      return;
    }

    if (u.searchParams.get('token') !== this.token) {
      res.writeHead(403).end('forbidden');
      return;
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      this.serveStatic(path.join(this.viewerDir, 'index.html'), res);
      return;
    }

    if (u.pathname === '/sessions') {
      this.aggregate()
        .then((list) => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
        })
        .catch(() => {
          res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
        });
      return;
    }

    // Route a kill to the backend that owns the session, just like /ws.
    if (u.pathname === '/kill') {
      if (req.method !== 'POST') {
        res.writeHead(405).end('method not allowed');
        return;
      }
      this.killSession(u.searchParams.get('session') || '')
        .then((ok) => {
          res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }));
        })
        .catch(() => {
          res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false }));
        });
      return;
    }

    res.writeHead(404).end('not found');
  }

  private serveStatic(filePath: string, res: http.ServerResponse): void {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.viewerDir))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  // ---------------------------------------------------------- aggregation

  // Fan out to every live backend's /sessions, merge, and refresh the
  // session→backend owner map used to route /ws upgrades.
  private async aggregate(): Promise<any[]> {
    const entries = registry.listEntries();
    const results = await Promise.all(entries.map((e) => this.fetchSessions(e)));

    const owners = new Map<string, Owner>();
    const merged: any[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      for (const s of results[i]) {
        if (!s || typeof s.id !== 'string' || seen.has(s.id)) continue;
        seen.add(s.id);
        owners.set(s.id, { port: e.port, token: e.token });
        merged.push({ id: s.id, shell: s.shell, startedAt: s.startedAt, viewers: s.viewers });
      }
    }
    this.owners = owners;
    return merged;
  }

  private fetchSessions(e: registry.RegistryEntry): Promise<any[]> {
    return new Promise((resolve) => {
      const url = `http://127.0.0.1:${e.port}/sessions?token=${encodeURIComponent(e.token)}`;
      const req = http.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve([]);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(Array.isArray(j) ? j : []);
          } catch {
            resolve([]);
          }
        });
      });
      req.setTimeout(1500, () => {
        req.destroy();
        resolve([]);
      });
      req.on('error', () => resolve([]));
    });
  }

  // --------------------------------------------------------------- kill

  // Find the backend that owns the session (re-aggregating once if the owner
  // map is stale) and POST /kill to it.
  private async killSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    let owner = this.owners.get(sessionId);
    if (!owner) {
      await this.aggregate();
      owner = this.owners.get(sessionId);
    }
    if (!owner) return false;
    return this.postKill(owner, sessionId);
  }

  private postKill(owner: Owner, sessionId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const reqPath =
        `/kill?token=${encodeURIComponent(owner.token)}&session=${encodeURIComponent(sessionId)}`;
      const req = http.request(
        { host: '127.0.0.1', port: owner.port, path: reqPath, method: 'POST' },
        (res) => {
          const ok = res.statusCode === 200;
          res.resume();
          resolve(ok);
        }
      );
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  // ------------------------------------------------------------ WS proxy

  private async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname !== '/ws' || u.searchParams.get('token') !== this.token) {
        socket.destroy();
        return;
      }
      const sessionId = u.searchParams.get('session') || '';
      let owner = this.owners.get(sessionId);
      if (!owner) {
        // Session may be newer than the last /sessions poll — re-aggregate once.
        await this.aggregate();
        owner = this.owners.get(sessionId);
      }
      if (!owner || !this.wss) {
        socket.destroy();
        return;
      }
      const backendUrl =
        `ws://127.0.0.1:${owner.port}/ws?token=${encodeURIComponent(owner.token)}` +
        `&session=${encodeURIComponent(sessionId)}`;
      this.wss.handleUpgrade(req, socket as any, head, (ws) => this.proxyWs(ws, backendUrl));
    } catch {
      socket.destroy();
    }
  }

  // Bridge browser ⇄ backend, preserving text/binary frame types so xterm gets
  // PTY bytes as binary and control messages ({type:'end'}) as text.
  private proxyWs(browserWs: WebSocket, backendUrl: string): void {
    const backendWs = new WebSocket(backendUrl);
    const queue: Array<[any, boolean]> = [];
    let backendOpen = false;
    let closed = false;

    const closeBoth = () => {
      if (closed) return;
      closed = true;
      try {
        browserWs.close();
      } catch {
        /* ignore */
      }
      try {
        backendWs.close();
      } catch {
        /* ignore */
      }
    };

    backendWs.on('open', () => {
      backendOpen = true;
      for (const [d, bin] of queue) {
        try {
          backendWs.send(d, { binary: bin });
        } catch {
          /* ignore */
        }
      }
      queue.length = 0;
    });
    backendWs.on('message', (data, isBinary) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(data, { binary: isBinary });
      }
    });
    backendWs.on('close', closeBoth);
    backendWs.on('error', closeBoth);

    browserWs.on('message', (data, isBinary) => {
      if (backendOpen && backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(data, { binary: isBinary });
      } else {
        queue.push([data, isBinary]);
      }
    });
    browserWs.on('close', closeBoth);
    browserWs.on('error', closeBoth);
  }
}
