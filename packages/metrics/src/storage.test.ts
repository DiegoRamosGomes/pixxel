import { describe, expect, it } from 'vitest';
import { parseDfDarwin, parseDfLinux, resolveMount } from './storage.js';

describe('armazenamento', () => {
  it('df -kPT do Linux em bytes, com tipo', () => {
    const txt =
      'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 400 600 40% /\ntmpfs tmpfs 100 0 100 0% /run\n';
    expect(parseDfLinux(txt)[0]).toEqual({
      source: '/dev/sda1',
      mount: '/',
      fstype: 'ext4',
      totalBytes: 1024000,
      usedBytes: 409600,
      availBytes: 614400,
      usedPercent: 40,
    });
  });

  it('df -kP do macOS aceita ponto de montagem com espaço', () => {
    const txt =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk4s1 1000 250 750 25% /Volumes/Meu Disco\n';
    expect(parseDfDarwin(txt)[0]).toMatchObject({ mount: '/Volumes/Meu Disco', fstype: '', usedPercent: 25 });
  });
});

describe('ponto de montagem padrão', () => {
  it('no macOS o "/" vira o volume de dados', () => {
    expect(resolveMount('/', 'darwin')).toBe('/System/Volumes/Data');
  });

  it('no Linux e em montagens explícitas fica como pedido', () => {
    expect(resolveMount('/', 'linux')).toBe('/');
    expect(resolveMount('/Volumes/X', 'darwin')).toBe('/Volumes/X');
    expect(resolveMount('all', 'darwin')).toBe('all');
  });
});
