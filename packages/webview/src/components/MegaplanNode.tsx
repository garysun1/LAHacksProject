import type { Node, NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { MegaplanNode as MegaplanNodeData } from '@megaplan/shared';

export type MegaplanNodeViewData = Record<string, unknown> & MegaplanNodeData & {
  childGraphId?: string;
  impacted?: boolean;
  selected?: boolean;
  onInspect?: (nodeId: string) => void;
  onExpand?: (nodeId: string) => void;
  onFocusGraph?: (graphId: string) => void;
};

export type MegaplanFlowNode = Node<MegaplanNodeViewData, 'megaplan'>;

export function MegaplanNode({ data }: NodeProps<MegaplanFlowNode>): JSX.Element {
  const actionTitle = data.childGraphId ? 'Open subgraph' : 'Open empty subgraph';
  const actionHandler = data.childGraphId ? () => data.onFocusGraph?.(data.childGraphId ?? '') : () => data.onExpand?.(data.id);

  return (
    <div className={`megaplan-node status-${data.status} ${data.impacted ? 'impacted' : ''} ${data.selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="node-content">
        <div className="node-main">
          <div className="node-title-row">
            <span className="node-status-dot" title={data.status} />
            <span className="node-title">{data.title}</span>
            <button type="button" title={actionTitle} onClick={actionHandler}>Open</button>
          </div>
          {data.summary ? <div className="node-description">{data.summary}</div> : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
