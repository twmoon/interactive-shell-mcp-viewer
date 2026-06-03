import * as fs from 'fs';
import * as path from 'path';

// Shared instance registry for the unified-hub model.
//
// Each MCP instance runs its own backend ViewerServer on an ephemeral port and
// drops a `<pid>.json` file here. One instance leader-elects to bind the fixed
// hub port (7682) and aggregates every backend listed in this registry, so all
// sessions from all instances show up on a single URL regardless of which
// instance owns the hub port.
//
// Files are intentionally per-pid (no locking needed): writes are atomic enough
// for this purpose, and dead entries are pruned lazily on every list().

export interface RegistryEntry {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

function registryDir(): string {
  return process.env.ISH_REGISTRY_DIR || path.join(__dirname, '..', '.registry');
}

function entryPath(pid: number): string {
  return path.join(registryDir(), `${pid}.json`);
}

// process.kill(pid, 0) probes existence without signalling:
//   - succeeds          → alive
//   - throws ESRCH      → dead
//   - throws EPERM      → exists but owned by another user → treat as alive
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e && e.code === 'EPERM';
  }
}

export function writeEntry(entry: { pid: number; port: number; token: string }): void {
  try {
    const dir = registryDir();
    fs.mkdirSync(dir, { recursive: true });
    const full: RegistryEntry = { ...entry, startedAt: Date.now() };
    fs.writeFileSync(entryPath(entry.pid), JSON.stringify(full));
  } catch {
    /* best-effort: a missing registry entry only loses aggregation for this pid */
  }
}

export function removeEntry(pid: number): void {
  try {
    fs.unlinkSync(entryPath(pid));
  } catch {
    /* already gone */
  }
}

// Returns live backend entries, pruning stale files for dead pids as a side effect.
export function listEntries(): RegistryEntry[] {
  const dir = registryDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    let entry: RegistryEntry | null = null;
    try {
      entry = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      entry = null;
    }
    if (!entry || typeof entry.pid !== 'number' || typeof entry.port !== 'number') {
      try {
        fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!isAlive(entry.pid)) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}
