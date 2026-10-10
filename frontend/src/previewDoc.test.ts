import { describe, expect, it } from 'vitest';
import { jsonForScript } from './previewDoc';

describe('jsonForScript', () => {
  it('cannot terminate the surrounding script tag', () => {
    const out = jsonForScript({ t: '</script><script>alert(1)</script>', u: '\u2028' });
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<');
    expect(JSON.parse(out).t).toBe('</script><script>alert(1)</script>');
  });
});
