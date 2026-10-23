import { describe, expect, it } from 'vitest';
import { parseDarwinNetstat, parseLinuxNetDev } from './network.js';

describe('rede', () => {
  it('soma bytes do /proc/net/dev ignorando lo', () => {
    const txt =
      'Inter-|   Receive\n face |bytes packets\n    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n' +
      '  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n';
    expect(parseLinuxNetDev(txt)).toEqual({ rxBytes: 1000, txBytes: 2000 });
  });

  it('ignora interfaces virtuais do Docker no Linux', () => {
    const txt = 'docker0: 9 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0\n  eth0: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0\n';
    expect(parseLinuxNetDev(txt)).toEqual({ rxBytes: 1, txBytes: 2 });
  });

  it('netstat -ibn: usa só linhas <Link#>, ignora lo*, conta colunas a partir do fim', () => {
    const txt = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'lo0        16384 <Link#1>                      16374166     0 27033566587 16374166     0 27033566587     0',
      'lo0        16384 127           127.0.0.1       16374166     - 27033566587 16374166     - 27033566587     -',
      'en0        1500  <Link#11>   84:2f:57:1b:77:ab  900 0 123456 800 0 654321 0',
      'en0        1500  192.168.0     192.168.0.10       900 - 123456 800 - 654321 -',
    ].join('\n');
    expect(parseDarwinNetstat(txt)).toEqual({ rxBytes: 123456, txBytes: 654321 });
  });
});
