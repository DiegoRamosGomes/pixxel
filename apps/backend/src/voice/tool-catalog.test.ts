import { describe, expect, it } from 'vitest';
import { LOCAL_OPS, type LocalOp } from '@assistant/shared';
import { routeTool, toolsForClient } from './tool-catalog.js';

const DESKTOP: LocalOp[] = [...LOCAL_OPS];

describe('catálogo de tools', () => {
  it('celular sem operações locais não recebe open_project nem media_control', () => {
    const names = toolsForClient([]).map((t) => t.name);
    expect(names).not.toContain('open_project');
    expect(names).not.toContain('media_control');
    expect(names).not.toContain('play_youtube');
    expect(names).toContain('weather');
    expect(names).toContain('system_status');
  });

  it('desktop recebe tudo', () => {
    expect(toolsForClient(DESKTOP).map((t) => t.name)).toEqual(
      expect.arrayContaining(['open_project', 'play_youtube', 'start_presentation']),
    );
  });

  it('roteia tool local direta para o cliente', () => {
    expect(routeTool('open_app', DESKTOP)).toEqual({ kind: 'local', op: 'open_app' });
  });

  it('tool local direta sem a operação fica indisponível', () => {
    expect(routeTool('open_project', [])).toEqual({
      kind: 'unavailable',
      reason: 'Função indisponível neste dispositivo.',
    });
  });

  it('tool mista sem requisito fica indisponível', () => {
    expect(routeTool('look_at_camera', ['open_url'])).toEqual({
      kind: 'unavailable',
      reason: 'Função indisponível neste dispositivo.',
    });
  });

  it('tool mista com requisitos roda no servidor', () => {
    expect(routeTool('look_at_camera', ['camera_frame'])).toEqual({ kind: 'server' });
  });

  it('tools de integração rodam no servidor', () => {
    expect(routeTool('trello_list_cards', [])).toEqual({ kind: 'server' });
  });

  it('nenhuma tool claude_* existe no catálogo', () => {
    expect(toolsForClient(DESKTOP).some((t) => t.name.startsWith('claude_'))).toBe(false);
  });

  it('system_status e storage_status exigem target server|device', () => {
    for (const name of ['system_status', 'storage_status']) {
      const decl = toolsForClient([]).find((t) => t.name === name)!;
      const params = decl.parameters as {
        properties: { target: { enum: string[] } };
        required: string[];
      };
      expect(params.properties.target.enum).toEqual(['server', 'device']);
      expect(params.required).toContain('target');
    }
  });
});
