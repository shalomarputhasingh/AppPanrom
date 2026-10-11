import { describe, expect, it } from 'vitest';
import { changeCount, collapse, diffLines } from './diff';

describe('diffLines', () => {
  it('reports no change for equal text', () => {
    expect(changeCount(diffLines('a\nb\n', 'a\nb\n'))).toEqual({ added: 0, removed: 0 });
  });
  it('finds an inserted line in the middle', () => {
    const d = diffLines('a\nb\nc\n', 'a\nb\nNEW\nc\n');
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['NEW']);
    expect(changeCount(d).removed).toBe(0);
  });
  it('finds a replaced line as one delete and one add', () => {
    const d = diffLines('a\nold\nc\n', 'a\nnew\nc\n');
    expect(changeCount(d)).toEqual({ added: 1, removed: 1 });
    expect(d.map((l) => l.kind)).toEqual(['same', 'del', 'add', 'same']);
  });
  it('rebuilding the new text from the diff always gives the new text', () => {
    const before = 'x\ny\nz\nw\n', after = 'y\nQ\nz\nR\nS\n';
    const d = diffLines(before, after);
    expect(d.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n')).toBe(after.trimEnd());
    expect(d.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n')).toBe(before.trimEnd());
  });
  it('collapses unchanged stretches', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const c = collapse(diffLines(lines, lines.replace('l15', 'CHANGED')), 2);
    expect(c.some((l) => l.kind === 'gap')).toBe(true);
    expect(c.filter((l) => l.kind === 'add')).toHaveLength(1);
  });
});
