const isTty = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';

const ansi = {
  reset: isTty ? '\x1b[0m' : '',
  dim: isTty ? '\x1b[2m' : '',
  bold: isTty ? '\x1b[1m' : '',
  red: isTty ? '\x1b[31m' : '',
  green: isTty ? '\x1b[32m' : '',
  yellow: isTty ? '\x1b[33m' : '',
  blue: isTty ? '\x1b[34m' : '',
  cyan: isTty ? '\x1b[36m' : '',
};

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function line(color, label, message) {
  const prefix = `${ansi.dim}[${stamp()}]${ansi.reset} ${color}${label}${ansi.reset}`;
  process.stdout.write(`${prefix} ${message}\n`);
}

export const logger = {
  info(message) {
    line(ansi.cyan, 'info', message);
  },
  ok(message) {
    line(ansi.green, 'ok  ', message);
  },
  warn(message) {
    line(ansi.yellow, 'warn', message);
  },
  error(message) {
    line(ansi.red, 'err ', message);
  },
  pkg(id, message) {
    line(ansi.blue, id.padEnd(22, ' '), message);
  },
  banner(lines) {
    const width = Math.max(...lines.map((item) => item.length), 20);
    const bar = '─'.repeat(width + 2);
    process.stdout.write(`\n${ansi.bold}${ansi.cyan}┌${bar}┐${ansi.reset}\n`);
    for (const item of lines) {
      process.stdout.write(`${ansi.cyan}│${ansi.reset} ${item.padEnd(width, ' ')} ${ansi.cyan}│${ansi.reset}\n`);
    }
    process.stdout.write(`${ansi.bold}${ansi.cyan}└${bar}┘${ansi.reset}\n\n`);
  },
  raw(text) {
    process.stdout.write(text);
  },
};

export function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}
