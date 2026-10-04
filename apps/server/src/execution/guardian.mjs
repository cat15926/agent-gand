// A stdio guardian survives server SIGKILL and reaps the owned POSIX group on IPC loss.
import { spawn } from 'node:child_process';
const token = process.argv[2];
let native; let stopping = false; let timer;
function stop() {
  if (stopping) return;
  stopping = true;
  timer = setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }, 500);
  try { process.kill(-process.pid, 'SIGTERM'); } catch { process.exit(1); }
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('disconnect', stop);
// CLI batch protocols use stdin EOF to begin inference; ownership comes from IPC.
process.stdin.pause();
function send(message, complete) {
  if (!process.connected) { complete?.(); return; }
  process.send(message, (error) => { complete?.(); if (error) stop(); });
}
process.on('message', (input) => {
  if (native || stopping || input?.type !== 'start') return;
  native = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdin.pipe(native.stdin);
  native.stdin.on('error', () => {});
  native.stdout.pipe(process.stdout, { end: false }); native.stderr.pipe(process.stderr, { end: false });
  native.on('error', (error) => { send({ type: 'spawnError', code: error.code }, stop); });
  native.on('exit', (code, signal) => { send({ type: 'exit', code, signal }, stop); });
  send({ type: 'started' });
});
// Parent must persist this owner before authorizing the first native spawn.
send({ type: 'ready', pid: process.pid, token });
