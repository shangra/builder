import { spawn } from 'node:child_process';

const children = new Set();

export function spawnCommand(command, { cwd, env = {}, onLine } = {}) {
  const childEnv = { ...process.env, npm_config_fund: 'false', ...env };
  if (!childEnv.NO_COLOR && childEnv.FORCE_COLOR == null) {
    childEnv.FORCE_COLOR = '1';
  }

  const child = spawn(command, {
    cwd,
    env: childEnv,
    shell: true,
    windowsHide: true,
  });

  children.add(child);

  let stdout = '';
  let stderr = '';

  const handleChunk = (chunk, stream) => {
    const text = chunk.toString();
    if (stream === 'stdout') {
      stdout += text;
    } else {
      stderr += text;
    }
    if (!onLine) {
      return;
    }
    const parts = text.split(/\r?\n/);
    for (const part of parts) {
      if (part.length > 0) {
        onLine(part);
      }
    }
  };

  child.stdout?.on('data', (chunk) => handleChunk(chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => handleChunk(chunk, 'stderr'));

  const done = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      children.delete(child);
      reject(error);
    });
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });

  return { child, done };
}

export function runCommand(command, { cwd, env = {}, dryRun = false, onLine } = {}) {
  if (dryRun) {
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  return spawnCommand(command, { cwd, env, onLine }).done;
}

export function killChildren() {
  for (const child of children) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // process already exited
    }
  }
  children.clear();
}
