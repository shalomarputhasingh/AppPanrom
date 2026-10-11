/** A small line diff (longest common subsequence) for showing what an AI suggestion would change. */
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  // trim the common head and tail first: most edits touch a small part of the file
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  if (x.length * y.length > 4_000_000) {                       // pathological size: show a plain replace instead of a huge table
    x.forEach((text) => out.push({ kind: 'del', text }));
    y.forEach((text) => out.push({ kind: 'add', text }));
  } else {
    const n = x.length, m = y.length;
    const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++; }
      else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: 'del', text: x[i++] });
      else out.push({ kind: 'add', text: y[j++] });
    }
    while (i < n) out.push({ kind: 'del', text: x[i++] });
    while (j < m) out.push({ kind: 'add', text: y[j++] });
  }
  a.slice(a.length - tail).forEach((text) => out.push({ kind: 'same', text }));
  return out;
}

/** Collapses long unchanged stretches, keeping `context` lines around each change. */
export function collapse(lines: DiffLine[], context = 2): (DiffLine | { kind: 'gap'; count: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true; });
  const out: (DiffLine | { kind: 'gap'; count: number })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) { if (gap) { out.push({ kind: 'gap', count: gap }); gap = 0; } out.push(l); } else gap++;
  });
  if (gap) out.push({ kind: 'gap', count: gap });
  return out;
}

export const changeCount = (lines: DiffLine[]) => ({ added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length });
