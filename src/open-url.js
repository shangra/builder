import { spawn } from 'node:child_process';

export function openUrl(url) {
  if (!url) {
    return;
  }
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}
