import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { IPty } from 'node-pty';
import * as registry from './registry.js';

const REPLAY_LIMIT = 256 * 1024; // scrollback sent to a viewer that joins mid-session

interface ViewerSession {
  id: string;
  pty: IPty;
  shell: string;
  startedAt: number;
  clients: Set<WebSocket>;
  replay: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Live read-only/takeover terminal viewer. Broadcasts the exact PTY stream the
// MCP client consumes, and forwards browser keystrokes back into the same PTY
// (shared session, like `screen -x`). Bound to 127.0.0.1 and gated by a token.
export class ViewerServer {
  private sessions = new Map<string, ViewerSession>();
  private wss?: WebSocketServer;
  private server?: http.Server;
  private viewerDir: string;
  readonly token: string;
  readonly enabled: boolean;
  port = 0;
  url = '';

  constructor() {
    this.enabled = process.env.ISH_VIEWER_DISABLE !== '1';
    this.token = process.env.ISH_VIEWER_TOKEN || crypto.randomBytes(8).toString('hex');
    this.viewerDir = path.join(__dirname, '..', 'viewer');
  }

  // This is now a *backend* viewer: it binds an ephemeral port and registers
  // itself so the leader-elected hub (port 7682) can aggregate and proxy to it.
  // It no longer fights for 7682 and no longer writes viewer-url.txt — the hub
  // owns the public URL. The backend still serves its own sessions directly,
  // which keeps the hub→backend proxy uniform (the hub talks to it like a peer).
  start(): void {
    if (!this.enabled) return;
    this.wss = new WebSocketServer({ noServer: true });

    const server = http.createServer((req, res) => this.handleHttp(req, res));
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server = server;

    server.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[viewer-backend] socket error:', err.message);
    });
    // Port 0 → OS picks a free ephemeral port; ISH_VIEWER_PORT can pin it (tests).
    const fixed = parseInt(process.env.ISH_VIEWER_PORT || '0', 10) || 0;
    server.listen(fixed, '127.0.0.1', () => {
      const addr = server.address();
      this.port = typeof addr === 'object' && addr ? addr.port : fixed;
      this.url = `http://127.0.0.1:${this.port}/?token=${this.token}`;
      registry.writeEntry({ pid: process.pid, port: this.port, token: this.token });
      console.error(`[viewer-backend] pid=${process.pid} port=${this.port} (registered)`);
    });
  }

  stop(): void {
    registry.removeEntry(process.pid);
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
  }

  addSession(id: string, pty: IPty, shell: string): void {
    if (!this.enabled) return;
    this.sessions.set(id, {
      id,
      pty,
      shell,
      startedAt: Date.now(),
      clients: new Set(),
      replay: '',
    });
  }

  broadcast(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.replay += data;
    if (s.replay.length > REPLAY_LIMIT) s.replay = s.replay.slice(-REPLAY_LIMIT);
    if (s.clients.size === 0) return;
    const buf = Buffer.from(data, 'utf8');
    for (const ws of s.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    }
  }

  removeSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const ws of s.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.sessions.delete(id);
  }

  private authed(req: http.IncomingMessage): URL | null {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    return u.searchParams.get('token') === this.token ? u : null;
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const u = new URL(req.url || '/', 'http://127.0.0.1');

    // Static vendor assets (xterm) are public — harmless library files.
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
      const list = [...this.sessions.values()].map((s) => ({
        id: s.id,
        shell: s.shell,
        startedAt: s.startedAt,
        viewers: s.clients.size,
      }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
      return;
    }

    // Kill a PTY this backend owns. Killing the pty fires the MCP server's
    // onExit, which calls removeSession() to notify viewers and drop the entry.
    if (u.pathname === '/kill') {
      if (req.method !== 'POST') {
        res.writeHead(405).end('method not allowed');
        return;
      }
      const s = this.sessions.get(u.searchParams.get('session') || '');
      if (!s) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false }));
        return;
      }
      try {
        s.pty.kill();
      } catch {
        /* ignore — process may already be gone */
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
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

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname !== '/ws' || u.searchParams.get('token') !== this.token) {
        socket.destroy();
        return;
      }
      const session = this.sessions.get(u.searchParams.get('session') || '');
      if (!session) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket as any, head, (ws) => this.onConnection(ws, session));
    } catch {
      socket.destroy();
    }
  }

  private onConnection(ws: WebSocket, session: ViewerSession): void {
    session.clients.add(ws);
    if (session.replay) ws.send(Buffer.from(session.replay, 'utf8'));

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        session.pty.write(msg.data);
      } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
        try {
          session.pty.resize(msg.cols, msg.rows);
        } catch {
          /* ignore */
        }
      }
    });

    ws.on('close', () => session.clients.delete(ws));
    ws.on('error', () => session.clients.delete(ws));
  }
}
