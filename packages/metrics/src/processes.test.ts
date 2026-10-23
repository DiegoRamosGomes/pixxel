import { describe, expect, it } from 'vitest';
import { parseDarwinPs, parseLinuxPs } from './processes.js';

describe('processos', () => {
  it('ps do Linux (pid comm %cpu %mem)', () => {
    expect(parseLinuxPs('  12 node 12.5 3.1\n 99 bash 0.0 0.1\n')).toEqual([
      { pid: 12, name: 'node', cpu: 12.5, mem: 3.1 },
      { pid: 99, name: 'bash', cpu: 0, mem: 0.1 },
    ]);
  });

  it('ps do macOS: pula cabeçalho, nome com espaços e vírgula decimal', () => {
    const txt =
      '  PID  %CPU %MEM COMM\n48031  63,9  4,7 com.apple.Virtualization.VirtualMachine\n  165  16.5  0.4 Google Chrome Helper\n';
    expect(parseDarwinPs(txt)).toEqual([
      { pid: 48031, name: 'com.apple.Virtualization.VirtualMachine', cpu: 63.9, mem: 4.7 },
      { pid: 165, name: 'Google Chrome Helper', cpu: 16.5, mem: 0.4 },
    ]);
  });
});
