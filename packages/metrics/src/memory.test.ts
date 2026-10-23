import { describe, expect, it } from 'vitest';
import { parseDarwinVmStat, parseLinuxMeminfo } from './memory.js';

describe('memória', () => {
  it('lê MemTotal e MemAvailable do /proc/meminfo', () => {
    const txt = 'MemTotal:       16303724 kB\nMemFree:  1000 kB\nMemAvailable:    9876544 kB\n';
    expect(parseLinuxMeminfo(txt)).toEqual({
      totalBytes: 16303724 * 1024,
      availableBytes: 9876544 * 1024,
    });
  });

  it('vm_stat: disponível = (free + inactive + speculative + purgeable) × página', () => {
    const txt =
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  82165.\nPages active: 471215.\n' +
      'Pages inactive: 407882.\nPages speculative: 69759.\nPages wired down: 190050.\nPages purgeable: 43060.\n';
    expect(parseDarwinVmStat(txt)).toEqual({
      availableBytes: (82165 + 407882 + 69759 + 43060) * 16384,
    });
  });

  it('saída irreconhecível vira null', () => {
    expect(parseLinuxMeminfo('nada')).toBeNull();
    expect(parseDarwinVmStat('nada')).toBeNull();
  });
});
