/** CSV の 1 行（RFC 4180 の引用）。null と undefined は空。 */
export function csvLine(values: readonly unknown[]): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'string' ? v : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

export function csv(header: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return [csvLine(header), ...rows.map((r) => csvLine(header.map((h) => r[h])))].join('\n') + '\n';
}
