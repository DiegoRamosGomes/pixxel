// Work log persistente — uma entrada por sessão de trabalho do Claude.
// Cada `claude.start()` cria um arquivo .md em ~/pixxel/work-log/ com:
//   - frontmatter (project, task, início, status)
//   - mensagens do assistente
//   - tool uses (Edit/Write/Bash detalhados pra ser reproduzível)
//   - mensagens diretas do usuário (chat panel)
//   - resultado final
//
// Permite o usuário pedir no futuro: "olha como fiz X no projeto Y" → Gemini
// pode listar/ler estas entradas pra replicar a abordagem.

import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORK_LOG_DIR = join(homedir(), 'pixxel', 'work-log');

// Tools cujos detalhes interessam pro usuário replicar depois. Para outras
// (Read/Grep/Glob/etc) só loga nome + 1-line summary.
const DETAILED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash']);
const TOOL_INPUT_MAX = 2000;

export type WorkLogSource = 'voice' | 'chat' | 'plan-review';

type ActiveSession = {
  filePath: string;
  startedAt: Date;
  task: string;
  project: string;
  projectName: string | null;
  /** Acumulador de texto do assistente — flush em próximo tool_use/user/result. */
  assistantBuf: string;
  /** Conta tool uses por tipo pra resumir no fim. */
  toolCounts: Map<string, number>;
  /** Lista de arquivos tocados (Edit/Write) pra resumo final. */
  filesTouched: Set<string>;
  /** Comandos rodados (Bash) pra resumo final. */
  commands: string[];
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function tsCompact(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

function tsHuman(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function timeOnly(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…[truncado]' : s;
}

export class WorkLog {
  private current: ActiveSession | null = null;
  private dir: string;

  constructor(dir = WORK_LOG_DIR) {
    this.dir = dir;
  }

  isActive(): boolean {
    return this.current !== null;
  }

  /** Ainda em sessão? Retorna info útil pro Gemini consultar. */
  currentInfo(): { project: string; projectName: string | null; task: string } | null {
    if (!this.current) return null;
    return {
      project: this.current.project,
      projectName: this.current.projectName,
      task: this.current.task,
    };
  }

  async startSession(input: {
    project: string;
    projectName: string | null;
    task: string;
    source: WorkLogSource;
  }): Promise<{ ok: boolean; filePath?: string; reason?: string }> {
    // Se já tem sessão ativa, fecha como interrompida antes de abrir nova.
    // Não deveria acontecer (runner é single-threaded), mas defesa em profundidade.
    if (this.current) {
      console.warn('[work-log] sessão anterior ainda ativa, fechando como interrompida');
      await this.endSession({ ok: false, finalText: '[sessão interrompida — outra começou]' });
    }

    try {
      await mkdir(this.dir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'mkdir falhou',
      };
    }

    const startedAt = new Date();
    const projName = input.projectName || input.project.split('/').pop() || 'sem-projeto';
    const fileName = `${tsCompact(startedAt)}-${slugify(projName)}-${slugify(input.task)}.md`;
    const filePath = join(this.dir, fileName);

    const head =
      `---\n` +
      `date: ${startedAt.toISOString()}\n` +
      `project: "${escapeYaml(projName)}"\n` +
      `project_path: "${escapeYaml(input.project)}"\n` +
      `task: "${escapeYaml(input.task)}"\n` +
      `source: ${input.source}\n` +
      `status: in-progress\n` +
      `---\n\n` +
      `# ${input.task}\n\n` +
      `**Projeto:** ${projName} (\`${input.project}\`)\n` +
      `**Início:** ${tsHuman(startedAt)}\n` +
      `**Origem:** ${input.source}\n\n` +
      `## Progresso\n\n`;

    try {
      await writeFile(filePath, head, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'writeFile falhou',
      };
    }

    this.current = {
      filePath,
      startedAt,
      task: input.task,
      project: input.project,
      projectName: input.projectName,
      assistantBuf: '',
      toolCounts: new Map(),
      filesTouched: new Set(),
      commands: [],
    };
    console.log(`[work-log] sessão iniciada: ${filePath}`);
    return { ok: true, filePath };
  }

  /** Acumula delta de texto do assistente. Flush ocorre em tool_use/user/result. */
  appendAssistantText(delta: string): void {
    if (!this.current) return;
    this.current.assistantBuf += delta;
  }

  async appendToolUse(tool: string, input: unknown): Promise<void> {
    if (!this.current) return;
    await this.flushAssistant();
    this.current.toolCounts.set(tool, (this.current.toolCounts.get(tool) ?? 0) + 1);

    const obj = (typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
    let block = `### ${timeOnly(new Date())} · 🔧 ${tool}\n`;

    if (DETAILED_TOOLS.has(tool)) {
      if (tool === 'Edit') {
        const file = String(obj.file_path ?? obj.path ?? '');
        const oldStr = String(obj.old_string ?? '');
        const newStr = String(obj.new_string ?? '');
        if (file) this.current.filesTouched.add(file);
        block += `**Arquivo:** \`${file}\`\n\n`;
        block += `<details><summary>diff</summary>\n\n`;
        block += '```diff\n' + truncate(
          oldStr.split('\n').map((l) => `- ${l}`).join('\n') + '\n' +
          newStr.split('\n').map((l) => `+ ${l}`).join('\n'),
          TOOL_INPUT_MAX,
        ) + '\n```\n\n</details>\n\n';
      } else if (tool === 'Write' || tool === 'NotebookEdit') {
        const file = String(obj.file_path ?? obj.path ?? '');
        const content = String(obj.content ?? obj.new_source ?? '');
        if (file) this.current.filesTouched.add(file);
        block += `**Arquivo:** \`${file}\`\n\n`;
        block += `<details><summary>conteúdo</summary>\n\n`;
        block += '```\n' + truncate(content, TOOL_INPUT_MAX) + '\n```\n\n</details>\n\n';
      } else if (tool === 'Bash') {
        const cmd = String(obj.command ?? '');
        const desc = String(obj.description ?? '');
        this.current.commands.push(cmd);
        if (desc) block += `_${desc}_\n\n`;
        block += '```bash\n' + truncate(cmd, TOOL_INPUT_MAX) + '\n```\n\n';
      }
    } else {
      // Tool sem detalhe rico — pega primeiro string dos args como sumário.
      let summary = '';
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v.length > 0 && v.length < 240) {
          summary = v;
          break;
        }
      }
      if (summary) block += `\`${summary}\`\n\n`;
    }

    await this.appendRaw(block);
  }

  async appendUserMessage(text: string): Promise<void> {
    if (!this.current || !text.trim()) return;
    await this.flushAssistant();
    const block =
      `### ${timeOnly(new Date())} · 👤 Você\n` +
      `${text.trim()}\n\n`;
    await this.appendRaw(block);
  }

  async endSession(result: { ok: boolean; finalText: string }): Promise<void> {
    if (!this.current) return;
    await this.flushAssistant();

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - this.current.startedAt.getTime();
    const durationMin = Math.max(1, Math.round(durationMs / 60000));

    const toolSummary =
      this.current.toolCounts.size > 0
        ? [...this.current.toolCounts.entries()]
            .map(([t, n]) => `${t}×${n}`)
            .join(', ')
        : 'nenhuma';
    const filesList = [...this.current.filesTouched];
    const filesPart =
      filesList.length > 0
        ? `**Arquivos tocados (${filesList.length}):**\n` +
          filesList.map((f) => `- \`${f}\``).join('\n') +
          '\n\n'
        : '';
    const cmdsPart =
      this.current.commands.length > 0
        ? `**Comandos rodados (${this.current.commands.length}):**\n` +
          this.current.commands.map((c) => `- \`${c.slice(0, 200)}\``).join('\n') +
          '\n\n'
        : '';

    const tail =
      `\n## Resultado\n\n` +
      `- **Status:** ${result.ok ? '✅ done' : '❌ error'}\n` +
      `- **Fim:** ${tsHuman(endedAt)} (~${durationMin} min)\n` +
      `- **Tools usadas:** ${toolSummary}\n\n` +
      filesPart +
      cmdsPart +
      `**Texto final do Claude:**\n\n` +
      (result.finalText.trim() || '_(sem texto)_') +
      '\n';

    const filePath = this.current.filePath;
    try {
      await appendFile(filePath, tail, 'utf8');
      // Atualiza frontmatter do status — re-escreve só o trecho `status:`.
      await this.patchStatus(filePath, result.ok ? 'done' : 'error');
    } catch (err) {
      console.warn('[work-log] falha ao gravar fim de sessão:', err);
    }

    console.log(
      `[work-log] sessão encerrada (${result.ok ? 'done' : 'error'}, ${durationMin}min): ${filePath}`,
    );
    this.current = null;

    // Indexa pra busca semântica (background, não bloqueia).
    void (async () => {
      try {
        const { indexWorklogFile } = await import('./integrations/embeddings.js');
        const filename = filePath.split('/').pop();
        if (filename) await indexWorklogFile(filename);
      } catch (err) {
        console.warn('[work-log] index pós-sessão falhou:', err);
      }
    })();
  }

  private async flushAssistant(): Promise<void> {
    if (!this.current || !this.current.assistantBuf.trim()) {
      if (this.current) this.current.assistantBuf = '';
      return;
    }
    const text = this.current.assistantBuf.trim();
    this.current.assistantBuf = '';
    const block =
      `### ${timeOnly(new Date())} · 🤖 Claude\n` +
      `${text}\n\n`;
    await this.appendRaw(block);
  }

  private async appendRaw(content: string): Promise<void> {
    if (!this.current) return;
    try {
      await appendFile(this.current.filePath, content, 'utf8');
    } catch (err) {
      console.warn('[work-log] appendFile falhou:', err);
    }
  }

  /** Substitui `status: in-progress` no frontmatter pelo status final. */
  private async patchStatus(filePath: string, status: 'done' | 'error'): Promise<void> {
    const { readFile, writeFile } = await import('node:fs/promises');
    const raw = await readFile(filePath, 'utf8');
    const next = raw.replace(/^status: in-progress$/m, `status: ${status}`);
    if (next !== raw) {
      await writeFile(filePath, next, 'utf8');
    }
  }
}
