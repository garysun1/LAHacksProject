import type { Node, NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { MegaplanNode as MegaplanNodeData } from '@megaplan/shared';

export type MegaplanNodeViewData = Record<string, unknown> & MegaplanNodeData & {
  impacted?: boolean;
  selected?: boolean;
  onInspect?: (nodeId: string) => void;
  onExpand?: (nodeId: string) => void;
};

export type MegaplanFlowNode = Node<MegaplanNodeViewData, 'megaplan'>;

export function MegaplanNode({ data }: NodeProps<MegaplanFlowNode>): JSX.Element {
  const confidence = typeof data.confidence === 'number' ? Math.round(data.confidence * 100) : undefined;
  const isLowConfidence = typeof data.confidence === 'number' && data.confidence < 0.6;

  return (
    <div className={`megaplan-node status-${data.status} kind-${data.kind} ${isLowConfidence ? 'low-confidence' : ''} ${data.impacted ? 'impacted' : ''} ${data.selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-header">
        <span className="node-kind">{data.kind}</span>
        {data.pinned ? <span className="node-badge">Pinned</span> : null}
        {confidence !== undefined ? <span className="node-confidence">{confidence}%</span> : null}
      </div>
      <div className="node-title">{data.title}</div>
      {data.summary ? <div className="node-summary">{data.summary}</div> : null}
      <div className="node-footer">
        <span>{data.status}</span>
        <button type="button" onClick={() => data.onInspect?.(data.id)}>Review</button>
        {data.expandable ? <button type="button" onClick={() => data.onExpand?.(data.id)}>{data.expanded ? 'Expanded' : 'Expand'}</button> : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
