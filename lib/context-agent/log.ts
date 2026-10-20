const t0 = Date.now();

function stamp(): string {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  return `[+${s}s]`;
}

export function log(repo: string, stage: string, message: string): void {
  console.log(`${stamp()} [${repo}] ${stage.padEnd(16)} ${message}`);
}

export function logHeader(message: string): void {
  console.log(`\n${stamp()} ===== ${message} =====`);
}
