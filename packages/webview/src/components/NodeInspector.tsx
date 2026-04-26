import { useEffect, useState, type KeyboardEvent } from 'react';
import type { MegaplanGraphScope, MegaplanNode, ToolUseRequest } from '@megaplan/shared';

type Props = {
  node?: MegaplanNode;
  graphs: MegaplanGraphScope[];
  toolUses: ToolUseRequest[];
  onCommand: (command: { type: string; [key: string]: unknown }) => void;
};

export function NodeInspector({ node, graphs, toolUses, onCommand }: Props): JSX.Element {
  if (!node) {
    return <aside className="inspector empty">Select a node to inspect rationale, artifacts, and decisions.</aside>;
  }

  const updateNodeDetails = (details: Pick<Partial<MegaplanNode>, 'title' | 'summary' | 'rationale'>): void => {
    onCommand({ type: 'updateNodeDetails', nodeId: node.id, ...details });
  };
  const nodeToolUses = toolUses.filter((toolUse) => toolUse.nodeId === node.id || node.entailedBy?.includes(toolUse.nodeId));
  const childGraph = node.childGraphId ? graphs.find((graph) => graph.id === node.childGraphId) : undefined;
  const terminal = node.abstraction === 'terminal' || node.abstraction === 'runnable' || node.expandable === false;

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span>{node.kind}</span>
        <strong>{node.status}</strong>
      </div>
      <div className="inspector-title-row">
        <EditableNodeText
          className="editable-node-title"
          multiline={false}
          value={node.title}
          onSave={(title) => updateNodeDetails({ title })}
        />
        <button type="button" onClick={() => onCommand({ type: 'deleteNode', nodeId: node.id })}>Delete</button>
      </div>
      <EditableNodeText
        className="editable-node-summary"
        multiline
        value={node.summary}
        onSave={(summary) => updateNodeDetails({ summary })}
      />
      {terminal ? <small className="node-footnote">Terminal node</small> : null}
      {childGraph && !terminal ? (
        <section>
          <h3>Subgraph</h3>
          <button className="alternative" type="button" onClick={() => onCommand({ type: 'focusGraph', graphId: childGraph.id })}>
            <strong>{childGraph.title}</strong>
            <span>{childGraph.status}</span>
            {childGraph.summary ? <small>{childGraph.summary}</small> : null}
          </button>
        </section>
      ) : null}
      {node.rationale ? <section><h3>Rationale</h3><p>{node.rationale}</p></section> : null}

      {node.alternatives?.length ? (
        <section>
          <h3>Alternatives</h3>
          {node.alternatives.map((alternative) => (
            <div className="alternative" key={alternative.id}>
              <strong>{alternative.title}{alternative.recommended ? ' · Recommended' : ''}{alternative.status ? ` · ${alternative.status}` : ''}</strong>
              <span>{alternative.summary}</span>
              <small>{alternative.tradeoffs.join(' · ')}</small>
              <span className="row-actions">
                <button type="button" onClick={() => onCommand({ type: 'selectAlternative', nodeId: node.id, alternativeId: alternative.id })}>Select</button>
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {node.artifacts?.length ? (
        <section>
          <h3>Artifacts</h3>
          {node.artifacts.map((artifact) => (
            <div className="artifact" key={artifact.id}>
              <strong>{artifact.title}</strong>
              {artifact.path ? <code>{artifact.path}</code> : null}
              {artifact.content ? <pre>{artifact.content}</pre> : null}
            </div>
          ))}
        </section>
      ) : null}

      {nodeToolUses.length ? (
        <section>
          <h3>Tool approvals</h3>
          {nodeToolUses.map((toolUse) => (
            <div className="tool-use" key={toolUse.id}>
              <strong>{toolUse.title}</strong>
              <p>{toolUse.description}</p>
              {toolUse.path ? <code>{toolUse.path}</code> : null}
              <div className="row-actions">
                <button type="button" disabled={toolUse.status !== 'pending'} onClick={() => onCommand({ type: 'approveToolUse', toolUseId: toolUse.id })}>Approve</button>
                <button type="button" disabled={toolUse.status !== 'pending'} onClick={() => onCommand({ type: 'rejectToolUse', toolUseId: toolUse.id })}>Reject</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

    </aside>
  );
}

function EditableNodeText({
  className,
  multiline,
  value,
  onSave
}: {
  className: string;
  multiline: boolean;
  value: string;
  onSave: (value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (): void => {
    const trimmedDraft = draft.trim();

    if (!trimmedDraft) {
      setDraft(value);
      return;
    }

    if (trimmedDraft !== value) {
      onSave(trimmedDraft);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.blur();
    }

    if (event.key === 'Escape') {
      setDraft(value);
      event.currentTarget.blur();
    }
  };

  if (multiline) {
    return (
      <textarea
        className={className}
        value={draft}
        rows={3}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    );
  }

  return (
    <input
      className={className}
      type="text"
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={handleKeyDown}
    />
  );
}
