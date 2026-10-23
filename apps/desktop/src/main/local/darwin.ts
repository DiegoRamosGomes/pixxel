// Peças do macOS que dá pra testar sem rodar nada: tradução de teclas pro
// cliclick, parsers de networksetup/ipconfig e o script JXA das teclas de mídia.

const MODIFIERS: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'cmd',
  cmd: 'cmd',
  meta: 'cmd',
  command: 'cmd',
};

// Nomes no formato do xdotool (o que o Gemini manda) → teclas do cliclick.
const KEYS: Record<string, string> = {
  return: 'return',
  enter: 'return',
  escape: 'esc',
  esc: 'esc',
  tab: 'tab',
  backspace: 'delete',
  delete: 'fwd-delete',
  space: 'space',
  up: 'arrow-up',
  down: 'arrow-down',
  left: 'arrow-left',
  right: 'arrow-right',
  home: 'home',
  end: 'end',
  page_up: 'page-up',
  prior: 'page-up',
  page_down: 'page-down',
  next: 'page-down',
};

/** "ctrl+c" → ['kd:ctrl', 't:c', 'ku:ctrl']; "Return" → ['kp:return']. */
export function toCliclickArgs(combo: string): string[] {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const keyName = parts.pop();
  if (!keyName) throw new Error(`combo inválido: ${combo}`);
  const mods = parts.map((m) => {
    const mapped = MODIFIERS[m.toLowerCase()];
    if (!mapped) throw new Error(`combo inválido: ${combo}`);
    return mapped;
  });
  let press: string;
  const lower = keyName.toLowerCase();
  if (KEYS[lower]) press = `kp:${KEYS[lower]}`;
  else if (/^f([1-9]|1[0-2])$/.test(lower)) press = `kp:${lower}`;
  else if ([...keyName].length === 1) press = `t:${keyName}`;
  else throw new Error(`combo inválido: ${combo}`);
  if (mods.length === 0) return [press];
  const m = mods.join(',');
  return [`kd:${m}`, press, `ku:${m}`];
}

/** Movimento do cliclick: com o botão pressionado precisa de `dm:` pra gerar arrasto. */
export function macMoveArg(x: number, y: number, dragging: boolean): string {
  return `${dragging ? 'dm' : 'm'}:${x},${y}`;
}

/** `networksetup -listallhardwareports` → device do Wi-Fi (ex.: en0). */
export function parseWifiDevice(output: string): string | null {
  const m = output.match(/Hardware Port: Wi-Fi\s*\nDevice: (\S+)/);
  return m ? m[1] : null;
}

/** `ipconfig getsummary <dev>` → SSID. Sem permissão de localização vem `<redacted>`. */
export function parseIpconfigSsid(output: string): string | null {
  const m = output.match(/^\s*SSID : (.+)$/m);
  if (!m) return null;
  const ssid = m[1].trim();
  return ssid === '<redacted>' || !ssid ? null : ssid;
}

const MEDIA_KEY: Record<'play_pause' | 'next' | 'previous', number> = {
  play_pause: 16, // NX_KEYTYPE_PLAY
  next: 17, // NX_KEYTYPE_NEXT
  previous: 18, // NX_KEYTYPE_PREVIOUS
};

/**
 * Script JXA (osascript -l JavaScript) que posta a tecla de mídia do sistema
 * — quem estiver tocando (Spotify, Music, aba do navegador) responde.
 */
export function mediaKeyScript(op: 'play_pause' | 'next' | 'previous'): string {
  const key = MEDIA_KEY[op];
  return [
    "ObjC.import('Cocoa');",
    'function post(key, down) {',
    '  const ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(',
    '    14, $.NSMakePoint(0, 0), down ? 0xa00 : 0xb00, 0, 0, null, 8, (key << 16) | ((down ? 0xa : 0xb) << 8), -1);',
    '  $.CGEventPost(0, ev.CGEvent);',
    '}',
    `post(${key}, true); post(${key}, false);`,
  ].join('\n');
}
