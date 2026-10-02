export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

export function formatGain(before: number | null | undefined, after: number | null | undefined): string {
  if (before == null || after == null || before === 0) return "—";
  const pct = ((before - after) / before) * 100;
  return `${pct >= 0 ? "-" : "+"}${Math.abs(pct).toFixed(0)}%`;
}
