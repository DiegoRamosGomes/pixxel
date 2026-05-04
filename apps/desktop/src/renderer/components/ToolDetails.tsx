// Renderiza o input de uma tool do Claude — diff git-style pra Edit, bloco
// pra Write, code block pra Bash, JSON cru pro resto. Reaproveitado entre
// permission inline e qualquer outro lugar que precisar.

function basename(p: string): string {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

type Props = {
  tool: string;
  input: Record<string, unknown>;
};

export function ToolDetails({ tool, input }: Props) {
  if (tool === 'Edit') {
    const filePath = String(input.file_path ?? input.path ?? '');
    const oldStr = String(input.old_string ?? input.oldText ?? '');
    const newStr = String(input.new_string ?? input.newText ?? '');
    const replaceAll = Boolean(input.replace_all);
    return (
      <div className="diff">
        <div className="diff__file">
          <span className="diff__file-name">{basename(filePath)}</span>
          <span className="diff__file-path">{filePath}</span>
          {replaceAll && <span className="diff__badge">replace all</span>}
        </div>
        <div className="diff__hunk">
          {oldStr.split('\n').map((line, i) => (
            <div key={`o-${i}`} className="diff__line diff__line--del">
              <span className="diff__sign">-</span>
              <span className="diff__text">{line || ' '}</span>
            </div>
          ))}
          {newStr.split('\n').map((line, i) => (
            <div key={`n-${i}`} className="diff__line diff__line--add">
              <span className="diff__sign">+</span>
              <span className="diff__text">{line || ' '}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (tool === 'Write') {
    const filePath = String(input.file_path ?? input.path ?? '');
    const content = String(input.content ?? '');
    return (
      <div className="diff">
        <div className="diff__file">
          <span className="diff__file-name">{basename(filePath)}</span>
          <span className="diff__file-path">{filePath}</span>
          <span className="diff__badge diff__badge--new">novo arquivo</span>
        </div>
        <div className="diff__hunk">
          {content.split('\n').map((line, i) => (
            <div key={i} className="diff__line diff__line--add">
              <span className="diff__sign">+</span>
              <span className="diff__text">{line || ' '}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    const description = input.description ? String(input.description) : '';
    return (
      <div className="cmd">
        {description && <div className="cmd__desc">{description}</div>}
        <pre className="cmd__block">
          <span className="cmd__prompt">$ </span>
          {cmd}
        </pre>
      </div>
    );
  }

  return <pre className="diff__fallback">{JSON.stringify(input, null, 2)}</pre>;
}
