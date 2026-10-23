import { describe, expect, it } from 'vitest';
import { macMoveArg, mediaKeyScript, parseIpconfigSsid, parseWifiDevice, toCliclickArgs } from './darwin.js';

describe('macOS: teclado via cliclick', () => {
  it('ctrl+c vira kd/t/ku', () => {
    expect(toCliclickArgs('ctrl+c')).toEqual(['kd:ctrl', 't:c', 'ku:ctrl']);
  });

  it('super+shift+Tab', () => {
    expect(toCliclickArgs('super+shift+Tab')).toEqual(['kd:cmd,shift', 'kp:tab', 'ku:cmd,shift']);
  });

  it('Return sozinho', () => {
    expect(toCliclickArgs('Return')).toEqual(['kp:return']);
  });

  it('setas e F-keys', () => {
    expect(toCliclickArgs('Up')).toEqual(['kp:arrow-up']);
    expect(toCliclickArgs('alt+F4')).toEqual(['kd:alt', 'kp:f4', 'ku:alt']);
  });

  it('combo inválido', () => {
    expect(() => toCliclickArgs('ctrl+Banana')).toThrow('combo inválido: ctrl+Banana');
  });
});

describe('macOS: Wi-Fi', () => {
  it('acha o device do Wi-Fi', () => {
    expect(
      parseWifiDevice(
        'Hardware Port: Ethernet Adapter (en4)\nDevice: en4\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 84:2f\n',
      ),
    ).toBe('en0');
  });

  it('sem Wi-Fi devolve null', () => {
    expect(parseWifiDevice('Hardware Port: Thunderbolt Bridge\nDevice: bridge0\n')).toBeNull();
  });

  it('SSID redigido vira null', () => {
    expect(parseIpconfigSsid('  BSSID : <redacted>\n  SSID : <redacted>\n')).toBeNull();
  });

  it('SSID visível', () => {
    expect(parseIpconfigSsid('  BSSID : aa:bb\n  SSID : Casa 5G\n')).toBe('Casa 5G');
  });
});

describe('macOS: teclas de mídia', () => {
  it('script de mídia usa o código da tecla', () => {
    expect(mediaKeyScript('next')).toContain('post(17, true)');
    expect(mediaKeyScript('play_pause')).toContain('post(16, false)');
    expect(mediaKeyScript('previous')).toContain('post(18, true)');
  });
});

describe('macOS: mouse por gestos', () => {
  it('com o botão pressionado o movimento vira arrasto', () => {
    expect(macMoveArg(10, 20, false)).toBe('m:10,20');
    expect(macMoveArg(10, 20, true)).toBe('dm:10,20');
  });
});
