import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => {}) },
}));

const { isSafeExternalUrl } = await import('./apps.js');

describe('isSafeExternalUrl', () => {
  it('aceita https', () => {
    expect(isSafeExternalUrl('https://g1.globo.com/x.ghtml')).toBe(true);
  });

  it('recusa http, file, javascript e texto que não é URL', () => {
    expect(isSafeExternalUrl('http://g1.globo.com')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('nada')).toBe(false);
  });
});
