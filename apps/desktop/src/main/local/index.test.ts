import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererEvent } from '../../shared/ipc.js';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => {}) },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1000, height: 500 } }) },
  app: { isPackaged: false, getAppPath: () => '/app', relaunch: vi.fn(), exit: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
}));
vi.mock('./projects.js', () => ({
  openProject: vi.fn(async (q: string) =>
    q === 'pixxel'
      ? { ok: true, text: 'Abrindo pixxel.', project: { name: 'pixxel', path: '/p/pixxel', root: '/p' } }
      : { ok: false, reason: 'não achei', alternatives: [{ name: 'outro' }] },
  ),
}));

const { executeLocalOp, supportedLocalOps } = await import('./index.js');
const { deliverFrame } = await import('./camera.js');

let events: RendererEvent[];
let ctx: { emit: (e: RendererEvent) => void; setActiveProject: ReturnType<typeof vi.fn> };

beforeEach(() => {
  events = [];
  ctx = { emit: (e) => events.push(e), setActiveProject: vi.fn() };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('operações locais', () => {
  it('open_url recusa esquema que não é http(s)', async () => {
    expect(await executeLocalOp('open_url', { url: 'file:///etc/passwd' }, ctx)).toEqual({
      ok: false,
      reason: 'URL inválida.',
    });
  });

  it('open_url abre http(s) no navegador', async () => {
    const { shell } = await import('electron');
    expect(await executeLocalOp('open_url', { url: 'https://youtu.be/a' }, ctx)).toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith('https://youtu.be/a');
  });

  it('open_chat emite ui_panel', async () => {
    const r = await executeLocalOp('open_chat', {}, ctx);
    expect(events).toContainEqual({ type: 'ui_panel', panel: 'chat', open: true });
    expect(r).toEqual({ ok: true, text: 'Chat aberto.' });
  });

  it('show_memory fecha o grafo quando open=false', async () => {
    await executeLocalOp('show_memory', { open: false }, ctx);
    expect(events).toContainEqual({ type: 'ui_panel', panel: 'memory_graph', open: false });
  });

  it('camera_frame devolve o dataUrl entregue pela janela', async () => {
    const p = executeLocalOp('camera_frame', { timeoutMs: 6000 }, ctx);
    const req = events.find((e) => e.type === 'request_camera_frame') as Extract<
      RendererEvent,
      { type: 'request_camera_frame' }
    >;
    deliverFrame(req.requestId, 'data:x');
    expect(await p).toEqual({ ok: true, meta: { dataUrl: 'data:x' } });
  });

  it('camera_frame sem resposta', async () => {
    vi.useFakeTimers();
    const p = executeLocalOp('camera_frame', { timeoutMs: 6000 }, ctx);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toEqual({ ok: false, reason: 'Câmera não respondeu.' });
  });

  it('open_project marca projeto ativo', async () => {
    const r = await executeLocalOp('open_project', { query: 'pixxel' }, ctx);
    expect(ctx.setActiveProject).toHaveBeenCalledWith('/p/pixxel', 'pixxel');
    expect(r).toEqual({ ok: true, text: 'Abrindo pixxel.', meta: { projectPath: '/p/pixxel', projectName: 'pixxel' } });
  });

  it('open_project sem match lista alternativas', async () => {
    expect(await executeLocalOp('open_project', { query: 'x' }, ctx)).toEqual({
      ok: false,
      reason: 'não achei Projetos disponíveis: outro.',
    });
  });

  it('media_control recusa operação inválida', async () => {
    expect(await executeLocalOp('media_control', { op: 'explode' }, ctx)).toEqual({
      ok: false,
      reason: 'operação de mídia inválida: explode',
    });
  });

  it('supportedLocalOps em win32 não oferece mouse nem VS Code', () => {
    expect(supportedLocalOps('win32')).not.toContain('desktop_mouse');
    expect(supportedLocalOps('win32')).not.toContain('open_project');
    expect(supportedLocalOps('darwin')).toContain('open_project');
    expect(supportedLocalOps('linux')).toContain('desktop_mouse');
  });
});
