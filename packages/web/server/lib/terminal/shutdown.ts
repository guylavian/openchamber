import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/** One row of the process table. */
interface ProcessEntry {
  pid: number;
  parent: number;
  group: number;
  zombie: boolean;
  started: string | undefined;
  command: string;
}

/** A process this shutdown is responsible for, keyed to its terminal's shell PID. */
interface OwnedProcess extends ProcessEntry {
  terminal: number;
}

/** The PTY a terminal session runs in (node-pty / bun-pty). */
export interface TerminalPty {
  pid: number;
  kill: (signal?: string) => void;
}

export interface TerminalToShutDown {
  process: TerminalPty;
  shellExecutable: string;
}

const execFileAsync = promisify(execFile);
const SHUTDOWN_GRACE_MS = 20_000;

// Job-control shells give foreground/background jobs their own process groups.
// Killing only -pty.pid misses those jobs; closing the PTY first sends SIGHUP.
const readProcesses = async () => {
  // Minimal server/container installations need not ship procps.
  if (process.platform === 'linux') {
    const processes = new Map<number, ProcessEntry>();
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const pid = Number(entry);
      processes.set(pid, { pid, parent: Number(fields[1]), group: Number(fields[2]), zombie: fields[0] === 'Z', started: fields[19], command: stat.slice(stat.indexOf('(') + 1, end) });
    }
    return processes;
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,comm='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  return new Map<number, ProcessEntry>(stdout.trim().split('\n').map(line => {
    const fields = line.trim().split(/\s+/);
    return [Number(fields[0]), { pid: Number(fields[0]), parent: Number(fields[1]), group: Number(fields[2]), zombie: fields[3]!.startsWith('Z'), started: fields.slice(4, 9).join(' '), command: fields.slice(9).join(' ') }];
  }));
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try { process.kill(pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
};

export async function shutdownTerminalProcesses(terminals: TerminalToShutDown[], { graceMs = SHUTDOWN_GRACE_MS }: { graceMs?: number } = {}): Promise<void> {
  if (!terminals.length) return;
  // ConPTY has no POSIX signal protocol. Its backend owns tree teardown.
  if (process.platform === 'win32') {
    for (const { process: pty } of terminals) {
      try { pty.kill(); } catch { /* already gone; other terminals still need cleanup */ }
    }
    return;
  }

  const deadline = Date.now() + graceMs;
  const owned = new Map<number, OwnedProcess>();
  const shells = new Map<number, TerminalPty>();
  try {
    let snapshot = await readProcesses();
    for (const terminal of terminals) {
      const current = snapshot.get(terminal.process.pid);
      if (!current || current.zombie) continue;
      owned.set(current.pid, { ...current, terminal: current.pid });
      // An exec'ed server occupies the shell PID, but must get the same grace
      // as a child. Only an actual shell is held open until its jobs finish.
      if (path.basename(current.command) === path.basename(terminal.shellExecutable)) shells.set(current.pid, terminal.process);
    }
    const signalled = new Set<number>();
    while (owned.size) {
      for (const [pid, previous] of owned) {
        const current = snapshot.get(pid);
        if (!current || current.zombie || current.started !== previous.started) { owned.delete(pid); shells.delete(pid); }
        else if (current.command !== previous.command) shells.delete(pid);
      }
      // Retain descendants before signalling anything, including separate job
      // groups and children still cleaning up after their parent has exited.
      let added;
      do {
        added = false;
        for (const current of snapshot.values()) {
          if (!current.zombie && !owned.has(current.pid) && owned.has(current.parent)) {
            owned.set(current.pid, { ...current, terminal: owned.get(current.parent)!.terminal });
            added = true;
          }
        }
      } while (added);
      for (const pid of owned.keys()) {
        if (!shells.has(pid) && !signalled.has(pid)) { signal(pid, 'SIGTERM'); signalled.add(pid); }
      }
      for (const [pid, pty] of shells) {
        const hasJobs = [...owned.values()].some(current => current.terminal === pid && current.pid !== pid);
        if (!hasJobs && !signalled.has(pid)) { pty.kill('SIGHUP'); signalled.add(pid); }
      }
      if (!owned.size) return;
      if (Date.now() >= deadline) {
        for (const current of owned.values()) {
          if (current.group === current.pid) signal(-current.group, 'SIGKILL');
          signal(current.pid, 'SIGKILL');
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      snapshot = await readProcesses();
    }
  } catch (error) {
    // A failed process-table read is not evidence that the jobs exited.
    console.warn('Terminal graceful shutdown failed; forcing owned PTYs closed:', (error as Error).message);
    for (const pid of owned.keys()) { try { signal(pid, 'SIGKILL'); } catch { /* best effort */ } }
    for (const { process: pty } of terminals) {
      try { pty.kill('SIGKILL'); } catch { /* continue with the remaining PTYs */ }
    }
  }
}
