// Executa uma tool call do Gemini em nome de um cliente conectado.
//
// O catálogo (tool-catalog.ts) diz onde a tool roda; aqui ela roda de fato:
// operações locais vão pro cliente via `local`, integrações rodam na API e
// as mistas combinam as duas coisas. Widgets voltam separados da resposta —
// eles são pra tela, não pro modelo (JSON de widget infla o contexto).

import type { LocalOp, LocalToolResult, StorageWidget, Widget } from '@assistant/shared';
import {
  formatSnapshotForVoice,
  type DiskInfo,
  type StorageResult,
  type SystemSnapshot,
} from '@assistant/metrics';
import type { IntegrationResult } from '../integrations/index.js';
import type { LookAtCameraResult, CaptureFrame } from '../integrations/vision.js';
import type { MemoryVault, MemoryType } from '../vault/memory-vault.js';
import type { SaveIdeaInput, SaveIdeaResult } from '../integrations/ideas.js';
import type { ToolCall } from './gemini-live.js';
import { routeTool } from './tool-catalog.js';

export type ToolOutcome = {
  response: Record<string, unknown>;
  widgets: Array<{ widget: Widget; delayMs: number }>;
};

export type ToolExecutorDeps = {
  localOps: readonly LocalOp[];
  local(op: LocalOp, args: Record<string, unknown>): Promise<LocalToolResult>;
  runIntegration(name: string, args: Record<string, unknown>): Promise<IntegrationResult | null>;
  memory: Pick<MemoryVault, 'remember' | 'update' | 'forget' | 'get'>;
  memoryIndex: {
    add(e: { name: string; type: string; description: string; content: string }): void;
    remove(name: string): void;
  };
  saveIdea(input: SaveIdeaInput): Promise<SaveIdeaResult>;
  lookAtCamera(question: string, capture: CaptureFrame): Promise<LookAtCameraResult>;
  serverSnapshot(): Promise<SystemSnapshot>;
  serverStorage(mount: string): Promise<StorageResult>;
  presentation: { start(): void; startMouseKeyboardTest(): void };
  markBriefingDone(): Promise<void>;
};

const reply = (response: Record<string, unknown>): ToolOutcome => ({ response, widgets: [] });

function slimLocal(r: LocalToolResult): Record<string, unknown> {
  return r.ok ? { ok: true, ...(r.text !== undefined ? { text: r.text } : {}) } : { ok: false, reason: r.reason };
}

function storageWidget(disks: DiskInfo[], mount: string): StorageWidget | undefined {
  if (disks.length === 0) return undefined;
  return {
    kind: 'storage',
    scope: mount === 'all' ? 'all' : 'single',
    disks: disks.map((d) => ({
      mount: d.mount,
      fstype: d.fstype,
      totalBytes: d.totalBytes,
      usedBytes: d.usedBytes,
      availBytes: d.availBytes,
      usedPercent: d.usedPercent,
    })),
  };
}

export function createToolExecutor(deps: ToolExecutorDeps): (call: ToolCall) => Promise<ToolOutcome> {
  const has = (op: LocalOp): boolean => deps.localOps.includes(op);

  async function memoryTool(call: ToolCall): Promise<ToolOutcome> {
    const a = call.args;
    if (call.name === 'remember') {
      const entry = {
        name: String(a.name ?? ''),
        type: String(a.type ?? '') as MemoryType,
        description: String(a.description ?? ''),
        content: String(a.content ?? ''),
        links: Array.isArray(a.links) ? (a.links as unknown[]).map(String) : [],
      };
      const r = await deps.memory.remember(entry);
      if (r.ok) deps.memoryIndex.add(entry);
      return reply({ ok: r.ok, text: r.ok ? 'Anotado.' : undefined, reason: r.reason });
    }
    if (call.name === 'update_memory') {
      const name = String(a.name ?? '');
      const r = await deps.memory.update({
        name,
        description: a.description !== undefined ? String(a.description) : undefined,
        content: a.content !== undefined ? String(a.content) : undefined,
        links: Array.isArray(a.links) ? (a.links as unknown[]).map(String) : undefined,
      });
      if (r.ok) {
        // Re-index com a entrada atualizada direto do cofre.
        const e = deps.memory.get(name);
        if (e) deps.memoryIndex.add({ name: e.name, type: e.type, description: e.description, content: e.content });
      }
      return reply({ ok: r.ok, text: r.ok ? 'Atualizado.' : undefined, reason: r.reason });
    }
    const name = String(a.name ?? '');
    const r = await deps.memory.forget(name);
    if (r.ok) deps.memoryIndex.remove(name);
    return reply({ ok: r.ok, text: r.ok ? 'Esqueci.' : undefined, reason: r.reason });
  }

  async function ideaTool(call: ToolCall): Promise<ToolOutcome> {
    const title = String(call.args.title ?? '').trim();
    const description = String(call.args.description ?? '').trim();
    if (!title || !description) return reply({ ok: false, reason: 'título e descrição são obrigatórios' });
    if (call.name === 'save_idea') {
      const res = await deps.saveIdea({ title, description });
      return reply(res.ok ? { ok: true, text: `Anotei "${title}" nas ideias.` } : { ok: false, reason: res.reason });
    }
    const plan = String(call.args.plan ?? '').trim();
    if (!plan) return reply({ ok: false, reason: 'plano vazio — Gemini precisa elaborar o plano técnico' });
    const saved = await deps.saveIdea({ title, description, plan });
    return reply(
      saved.ok ? { ok: true, text: `Plano de "${title}" salvo nas ideias.` } : { ok: false, reason: saved.reason },
    );
  }

  async function systemStatus(call: ToolCall): Promise<ToolOutcome> {
    if (call.args.target === 'device') {
      if (!has('device_status')) return reply({ ok: false, reason: 'Este dispositivo não informa métricas de hardware.' });
      return reply(slimLocal(await deps.local('device_status', {})));
    }
    return reply({ ok: true, text: formatSnapshotForVoice(await deps.serverSnapshot(), 'servidor') });
  }

  async function storageStatus(call: ToolCall): Promise<ToolOutcome> {
    const mount = call.args.mount ? String(call.args.mount) : '/';
    let text: string;
    let disks: DiskInfo[];
    if (call.args.target === 'device') {
      if (!has('device_storage')) return reply({ ok: false, reason: 'Este dispositivo não informa armazenamento.' });
      const r = await deps.local('device_storage', { mount });
      if (!r.ok) return reply({ ok: false, reason: r.reason });
      text = r.text ?? '';
      disks = Array.isArray(r.meta?.disks) ? (r.meta.disks as DiskInfo[]) : [];
    } else {
      try {
        const r = await deps.serverStorage(mount);
        text = r.text;
        disks = r.disks;
      } catch (err) {
        return reply({ ok: false, reason: err instanceof Error ? err.message : 'falhou ao ler df' });
      }
    }
    const widget = storageWidget(disks, mount);
    return { response: { ok: true, text }, widgets: widget ? [{ widget, delayMs: 0 }] : [] };
  }

  async function integration(call: ToolCall): Promise<ToolOutcome | null> {
    const res = await deps.runIntegration(call.name, call.args);
    if (!res) return null;
    if (!res.ok) {
      return reply({ ok: false, reason: res.reason, ...(res.text ? { text: res.text } : {}) });
    }
    const meta = res.meta ? { ...res.meta } : undefined;
    const openUrl = typeof meta?.openUrl === 'string' ? meta.openUrl : undefined;
    if (meta) delete meta.openUrl;
    if (openUrl && has('open_url')) {
      const opened = await deps.local('open_url', { url: openUrl });
      // play_youtube sem abrir não tocou nada — o resto (plano de estudo) segue
      // válido mesmo sem o vídeo aberto.
      if (!opened.ok && call.name === 'play_youtube') return reply({ ok: false, reason: opened.reason });
    }
    const widgets: ToolOutcome['widgets'] = [];
    if (res.widget) widgets.push({ widget: res.widget, delayMs: 0 });
    res.widgets?.forEach((w, i) => widgets.push({ widget: w, delayMs: res.widgetDelaysMs?.[i] ?? 0 }));
    if (call.name === 'morning_briefing') await deps.markBriefingDone();
    return {
      response: { ok: true, text: res.text, ...(meta && Object.keys(meta).length > 0 ? { meta } : {}) },
      widgets,
    };
  }

  return async (call: ToolCall): Promise<ToolOutcome> => {
    const route = routeTool(call.name, deps.localOps);
    if (route.kind === 'unavailable') return reply({ ok: false, reason: route.reason });
    if (route.kind === 'local') return reply(slimLocal(await deps.local(route.op, call.args)));

    switch (call.name) {
      case 'remember':
      case 'update_memory':
      case 'forget_memory':
        return memoryTool(call);
      case 'save_idea':
      case 'plan_feature':
        return ideaTool(call);
      case 'look_at_camera': {
        const question = String(call.args.question ?? '').trim();
        const r = await deps.lookAtCamera(question, async (timeoutMs) => {
          const frame = await deps.local('camera_frame', { timeoutMs });
          return frame.ok && typeof frame.meta?.dataUrl === 'string' ? frame.meta.dataUrl : null;
        });
        return reply(r.ok ? { ok: true, text: r.text } : { ok: false, reason: r.reason });
      }
      case 'system_status':
        return systemStatus(call);
      case 'storage_status':
        return storageStatus(call);
      case 'test_desktop_control':
        deps.presentation.startMouseKeyboardTest();
        return reply({
          ok: true,
          text:
            'Teste de mouse e teclado iniciado. Observa o cursor — vou ' +
            'desenhar na tela e depois digitar onde o foco estiver. Esc ' +
            'cancela.',
        });
      case 'start_presentation':
        deps.presentation.start();
        return reply({
          ok: true,
          text: 'Apresentação iniciada. Vou narrar e operar o app sozinho. Aperta Esc se quiser parar.',
        });
    }

    const out = await integration(call);
    return out ?? reply({ ok: false, reason: `tool desconhecida: ${call.name}` });
  };
}
