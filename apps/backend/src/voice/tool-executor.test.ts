import { describe, expect, it, vi } from 'vitest';
import { LOCAL_OPS, type LocalOp, type Widget } from '@assistant/shared';
import type { SystemSnapshot } from '@assistant/metrics';
import { createToolExecutor, type ToolExecutorDeps } from './tool-executor.js';

const ALL: LocalOp[] = [...LOCAL_OPS];
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: '1', name, args });

function deps(over: Partial<ToolExecutorDeps> = {}): ToolExecutorDeps {
  return {
    localOps: ALL,
    local: vi.fn().mockResolvedValue({ ok: true, text: 'ok' }),
    runIntegration: vi.fn().mockResolvedValue({ ok: true, text: 't' }),
    memory: {
      remember: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      forget: vi.fn().mockResolvedValue({ ok: true }),
      get: vi.fn().mockReturnValue(undefined),
    },
    memoryIndex: { add: vi.fn(), remove: vi.fn() },
    saveIdea: vi.fn().mockResolvedValue({ ok: true, path: '/x', status: 'ideia', anchor: '#x' }),
    lookAtCamera: vi.fn().mockResolvedValue({ ok: true, text: 'Vejo uma caneca.' }),
    serverSnapshot: vi.fn().mockResolvedValue({
      cpuPercent: 10,
      memUsedBytes: 1024 ** 3,
      memTotalBytes: 2 * 1024 ** 3,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
      top: { topCpu: [], topMem: [] },
    } satisfies SystemSnapshot),
    serverStorage: vi.fn().mockResolvedValue({ text: 'Disco /: ...', disks: [] }),
    presentation: { start: vi.fn(), startMouseKeyboardTest: vi.fn() },
    markBriefingDone: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const disk = {
  source: '/dev/sda1',
  mount: '/',
  fstype: 'ext4',
  totalBytes: 100,
  usedBytes: 40,
  availBytes: 60,
  usedPercent: 40,
};

describe('executor de tools', () => {
  it('tool local direta vai para o cliente sem meta', async () => {
    const local = vi.fn().mockResolvedValue({ ok: true, text: 'Abri.', meta: { projectPath: '/x' } });
    const out = await createToolExecutor(deps({ local }))(call('open_project', { query: 'pixxel' }));
    expect(local).toHaveBeenCalledWith('open_project', { query: 'pixxel' });
    expect(out).toEqual({ response: { ok: true, text: 'Abri.' }, widgets: [] });
  });

  it('tool indisponível no dispositivo responde o motivo', async () => {
    const out = await createToolExecutor(deps({ localOps: [] }))(call('open_project', { query: 'x' }));
    expect(out.response).toEqual({ ok: false, reason: 'Função indisponível neste dispositivo.' });
  });

  it('play_youtube busca na API e abre a URL no cliente', async () => {
    const yt: Widget = {
      kind: 'youtube',
      videoId: 'a',
      title: 'X',
      thumbnailUrl: 'https://i.ytimg.com/vi/a/mqdefault.jpg',
      url: 'https://youtu.be/a',
    } as Widget;
    const runIntegration = vi.fn().mockResolvedValue({
      ok: true,
      text: 'Tocando "X".',
      widget: yt,
      meta: { videoId: 'a', url: 'https://youtu.be/a', openUrl: 'https://youtu.be/a' },
    });
    const local = vi.fn().mockResolvedValue({ ok: true });
    const out = await createToolExecutor(deps({ runIntegration, local }))(call('play_youtube', { query: 'x' }));
    expect(local).toHaveBeenCalledWith('open_url', { url: 'https://youtu.be/a' });
    expect(out.widgets).toEqual([{ widget: yt, delayMs: 0 }]);
    expect(out.response).toEqual({ ok: true, text: 'Tocando "X".', meta: { videoId: 'a', url: 'https://youtu.be/a' } });
  });

  it('play_youtube sem conseguir abrir não mostra widget', async () => {
    const runIntegration = vi.fn().mockResolvedValue({
      ok: true,
      text: 'Tocando "X".',
      widget: { kind: 'youtube' },
      meta: { url: 'https://youtu.be/a', openUrl: 'https://youtu.be/a' },
    });
    const local = vi.fn().mockResolvedValue({ ok: false, reason: 'x' });
    const out = await createToolExecutor(deps({ runIntegration, local }))(call('play_youtube', { query: 'x' }));
    expect(out).toEqual({ response: { ok: false, reason: 'x' }, widgets: [] });
  });

  it('plano de estudo abre o vídeo no cliente quando ele sabe abrir URL', async () => {
    const runIntegration = vi.fn().mockResolvedValue({
      ok: true,
      text: 'Próximo tópico.',
      meta: { planId: 'p', openUrl: 'https://youtu.be/b' },
    });
    const local = vi.fn().mockResolvedValue({ ok: true });
    const out = await createToolExecutor(deps({ runIntegration, local }))(call('study_plan_next'));
    expect(local).toHaveBeenCalledWith('open_url', { url: 'https://youtu.be/b' });
    expect(out.response).toEqual({ ok: true, text: 'Próximo tópico.', meta: { planId: 'p' } });
  });

  it('plano de estudo no celular sem open_url não tenta abrir', async () => {
    const runIntegration = vi.fn().mockResolvedValue({ ok: true, text: 't', meta: { openUrl: 'https://youtu.be/b' } });
    const local = vi.fn();
    await createToolExecutor(deps({ runIntegration, local, localOps: [] }))(call('study_plan_next'));
    expect(local).not.toHaveBeenCalled();
  });

  it('look_at_camera usa o frame do cliente', async () => {
    const local = vi.fn().mockResolvedValue({ ok: true, meta: { dataUrl: 'data:image/jpeg;base64,AA' } });
    const lookAtCamera = vi.fn(async (_q: string, capture: (t: number) => Promise<string | null>) => {
      expect(await capture(4000)).toBe('data:image/jpeg;base64,AA');
      return { ok: true as const, text: 'Vejo uma caneca.' };
    });
    const out = await createToolExecutor(deps({ local, lookAtCamera }))(call('look_at_camera', { question: 'o que é?' }));
    expect(local).toHaveBeenCalledWith('camera_frame', { timeoutMs: 4000 });
    expect(out.response).toEqual({ ok: true, text: 'Vejo uma caneca.' });
  });

  it('system_status device sem capacidade explica o motivo', async () => {
    const out = await createToolExecutor(deps({ localOps: [] }))(call('system_status', { target: 'device' }));
    expect(out.response).toEqual({ ok: false, reason: 'Este dispositivo não informa métricas de hardware.' });
  });

  it('system_status device repassa ao cliente', async () => {
    const local = vi.fn().mockResolvedValue({ ok: true, text: 'este dispositivo: CPU em 5%' });
    const out = await createToolExecutor(deps({ local }))(call('system_status', { target: 'device' }));
    expect(local).toHaveBeenCalledWith('device_status', {});
    expect(out.response).toEqual({ ok: true, text: 'este dispositivo: CPU em 5%' });
  });

  it('system_status server usa o snapshot do servidor', async () => {
    const out = await createToolExecutor(deps())(call('system_status', { target: 'server' }));
    expect(String(out.response.text)).toMatch(/^servidor: CPU em 10%/);
  });

  it('storage_status device monta widget com os discos do cliente', async () => {
    const local = vi.fn().mockResolvedValue({ ok: true, text: 'Disco /: …', meta: { disks: [disk] } });
    const out = await createToolExecutor(deps({ local }))(call('storage_status', { target: 'device', mount: '/' }));
    expect(local).toHaveBeenCalledWith('device_storage', { mount: '/' });
    expect(out.widgets[0].widget).toMatchObject({ kind: 'storage', scope: 'single' });
    expect(out.response).toEqual({ ok: true, text: 'Disco /: …' });
  });

  it('storage_status device sem capacidade explica o motivo', async () => {
    const out = await createToolExecutor(deps({ localOps: [] }))(call('storage_status', { target: 'device' }));
    expect(out.response).toEqual({ ok: false, reason: 'Este dispositivo não informa armazenamento.' });
  });

  it('integração com widget devolve widget fora da resposta', async () => {
    const W = { kind: 'weather' } as Widget;
    const runIntegration = vi.fn().mockResolvedValue({ ok: true, text: 't', widget: W });
    const out = await createToolExecutor(deps({ runIntegration }))(call('weather'));
    expect(out).toEqual({ response: { ok: true, text: 't' }, widgets: [{ widget: W, delayMs: 0 }] });
  });

  it('widgets múltiplos mantêm os atrasos', async () => {
    const A = { kind: 'weather' } as Widget;
    const B = { kind: 'tasks-list' } as Widget;
    const runIntegration = vi.fn().mockResolvedValue({ ok: true, text: 't', widgets: [A, B], widgetDelaysMs: [0, 2500] });
    const out = await createToolExecutor(deps({ runIntegration }))(call('morning_briefing'));
    expect(out.widgets).toEqual([
      { widget: A, delayMs: 0 },
      { widget: B, delayMs: 2500 },
    ]);
  });

  it('remember grava e indexa', async () => {
    const d = deps();
    const out = await createToolExecutor(d)(
      call('remember', { name: 'x', type: 'user', description: 'd', content: 'c' }),
    );
    expect(d.memory.remember).toHaveBeenCalled();
    expect(d.memoryIndex.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'x', type: 'user' }));
    expect(out.response).toEqual({ ok: true, text: 'Anotado.' });
  });

  it('forget_memory remove do índice', async () => {
    const d = deps();
    const out = await createToolExecutor(d)(call('forget_memory', { name: 'x' }));
    expect(d.memoryIndex.remove).toHaveBeenCalledWith('x');
    expect(out.response).toEqual({ ok: true, text: 'Esqueci.' });
  });

  it('save_idea responde com o texto novo', async () => {
    const out = await createToolExecutor(deps())(call('save_idea', { title: 'Ideia', description: 'd' }));
    expect(out.response).toEqual({ ok: true, text: 'Anotei "Ideia" nas ideias.' });
  });

  it('morning_briefing ok marca o briefing do dia', async () => {
    const d = deps();
    await createToolExecutor(d)(call('morning_briefing'));
    expect(d.markBriefingDone).toHaveBeenCalledTimes(1);
  });

  it('start_presentation dispara a apresentação e responde na hora', async () => {
    const d = deps();
    const out = await createToolExecutor(d)(call('start_presentation'));
    expect(d.presentation.start).toHaveBeenCalledTimes(1);
    expect(out.response.ok).toBe(true);
  });

  it('tool desconhecida', async () => {
    const runIntegration = vi.fn().mockResolvedValue(null);
    const out = await createToolExecutor(deps({ runIntegration }))(call('foo'));
    expect(out.response).toEqual({ ok: false, reason: 'tool desconhecida: foo' });
  });
});
