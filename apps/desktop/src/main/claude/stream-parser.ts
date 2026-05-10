/**
 * Parser do output stream-json do `claude -p --output-format stream-json`.
 *
 * Cada linha é um JSON com `type`. Os tipos relevantes:
 *
 *   {type:"system", subtype:"init", session_id, model, tools}
 *   {type:"assistant", message:{role, content:[{type:"text",text} | {type:"tool_use",id,name,input}]}}
 *   {type:"user", message:{role, content:[{type:"tool_result",tool_use_id,content}]}}
 *   {type:"result", subtype, is_error, result, stop_reason, session_id, total_cost_usd}
 *   {type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text}}}  -- com --include-partial-messages
 *
 * Implementação faz buffer por linha (stdout pode chegar em chunks parciais)
 * e classifica eventos em formato fácil pro restante do app consumir.
 */

export interface ParsedSystemInit {
  kind: 'system_init';
  sessionId: string;
  model: string;
}

export interface ParsedAssistantText {
  kind: 'assistant_text';
  text: string;
}

export interface ParsedToolUse {
  kind: 'tool_use';
  toolUseId: string;
  tool: string;
  input: unknown;
}

export interface ParsedToolResult {
  kind: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ParsedResult {
  kind: 'result';
  ok: boolean;
  text: string;
  stopReason: string;
  sessionId: string;
}

export interface ParsedError {
  kind: 'error';
  message: string;
}

export type ParsedEvent =
  | ParsedSystemInit
  | ParsedAssistantText
  | ParsedToolUse
  | ParsedToolResult
  | ParsedResult
  | ParsedError;

export class StreamJsonParser {
  private buffer = '';

  feed(chunk: string): ParsedEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const events: ParsedEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = this.parseLine(trimmed);
      if (parsed) events.push(...parsed);
    }
    return events;
  }

  /** Drena qualquer JSON pendente no buffer (chamar quando o stream fechar). */
  flush(): ParsedEvent[] {
    const remainder = this.buffer.trim();
    this.buffer = '';
    if (!remainder) return [];
    return this.parseLine(remainder) ?? [];
  }

  private parseLine(line: string): ParsedEvent[] | null {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return [{ kind: 'error', message: `linha não-JSON: ${line.slice(0, 200)}` }];
    }

    const type = obj.type;

    if (type === 'system' && obj.subtype === 'init') {
      const sessionId = typeof obj.session_id === 'string' ? obj.session_id : '';
      const model = typeof obj.model === 'string' ? obj.model : '';
      return [{ kind: 'system_init', sessionId, model }];
    }

    if (type === 'assistant') {
      const message = obj.message as { content?: unknown[] } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const out: ParsedEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          out.push({ kind: 'assistant_text', text: b.text });
        } else if (b.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            toolUseId: typeof b.id === 'string' ? b.id : '',
            tool: typeof b.name === 'string' ? b.name : '',
            input: b.input,
          });
        }
      }
      return out;
    }

    if (type === 'user') {
      const message = obj.message as { content?: unknown[] } | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const out: ParsedEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result') {
          const raw = b.content;
          let text = '';
          if (typeof raw === 'string') text = raw;
          else if (Array.isArray(raw)) {
            text = raw
              .map((x) => (typeof x === 'object' && x && 'text' in x ? String((x as Record<string, unknown>).text ?? '') : ''))
              .filter(Boolean)
              .join('\n');
          }
          out.push({
            kind: 'tool_result',
            toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
            content: text,
            isError: b.is_error === true,
          });
        }
      }
      return out;
    }

    if (type === 'result') {
      const ok = obj.is_error !== true;
      const text = typeof obj.result === 'string' ? obj.result : '';
      const stopReason = typeof obj.stop_reason === 'string' ? obj.stop_reason : '';
      const sessionId = typeof obj.session_id === 'string' ? obj.session_id : '';
      return [{ kind: 'result', ok, text, stopReason, sessionId }];
    }

    // stream_event (partial messages), hook_event, etc — ignorados na Fase 1.
    return [];
  }
}
