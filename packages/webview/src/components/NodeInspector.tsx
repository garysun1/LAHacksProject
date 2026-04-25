import type { MegaplanNode, ToolUseRequest } from '@megaplan/shared';

type Props = {
  node?: MegaplanNode;
  toolUses: ToolUseRequest[];
  onCommand: (command: { type: string; [key: string]: unknown }) => void;
};

export function NodeInspector({ node, toolUses, onCommand }: Props): JSX.Element {
  if (!node) {
    return <aside className="inspector empty">Select a node to inspect rationale, artifacts, and decisions.</aside>;
  }

  const nodeToolUses = toolUses.filter((toolUse) => toolUse.nodeId === node.id || node.entailedBy?.includes(toolUse.nodeId));

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span>{node.kind}</span>
        <strong>{node.status}</strong>
      </div>
      <h2>{node.title}</h2>
      {node.summary ? <p>{node.summary}</p> : null}
      {node.rationale ? <section><h3>Rationale</h3><p>{node.rationale}</p></section> : null}

      {node.alternatives?.length ? (
        <section>
          <h3>Alternatives</h3>
          {node.alternatives.map((alternative) => (
            <button className="alternative" type="button" key={alternative.id} onClick={() => onCommand({ type: 'selectAlternative', nodeId: node.id, alternativeId: alternative.id })}>
              <strong>{alternative.title}{alternative.recommended ? ' · Recommended' : ''}</strong>
              <span>{alternative.summary}</span>
              <small>{alternative.tradeoffs.join(' · ')}</small>
            </button>
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

      <div className="row-actions sticky-actions">
        <button type="button" onClick={() => onCommand({ type: 'pinNode', nodeId: node.id, pinned: !node.pinned })}>{node.pinned ? 'Unpin' : 'Pin'}</button>
        <button type="button" onClick={() => onCommand({ type: 'approveNode', nodeId: node.id })}>Approve</button>
        <button type="button" onClick={() => onCommand({ type: 'rejectNode', nodeId: node.id, reason: 'Rejected in Megaplan review.' })}>Reject</button>
        <button type="button" onClick={() => onCommand({ type: 'deleteNode', nodeId: node.id })}>Delete</button>
      </div>
    </aside>
  );
}
