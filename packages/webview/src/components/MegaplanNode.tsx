import type { Node, NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { MegaplanNode as MegaplanNodeData } from '@megaplan/shared';

export type MegaplanNodeViewData = Record<string, unknown> & MegaplanNodeData & {
  childGraphId?: string;
  active?: boolean;
  impacted?: boolean;
  selected?: boolean;
  onInspect?: (nodeId: string) => void;
};

export type MegaplanFlowNode = Node<MegaplanNodeViewData, 'megaplan'>;

export function MegaplanNode({ data }: NodeProps<MegaplanFlowNode>): JSX.Element {
  const terminal = data.abstraction === 'terminal' || data.abstraction === 'runnable' || data.expandable === false;

  return (
    <div className={`megaplan-node status-${data.status} ${terminal ? 'terminal' : ''} ${data.active ? 'active' : ''} ${data.impacted ? 'impacted' : ''} ${data.selected ? 'selected' : ''}`} title={terminal ? 'Terminal node' : 'Double-click to open subgraph'}>
      <Handle type="target" position={Position.Top} />
      <div className="node-content">
        <div className="node-main">
          <div className="node-title-row">
            <span className="node-status-dot" title={data.status} />
            <span className="node-title">{data.title}</span>
          </div>
          <div className="node-description">{data.summary}</div>
          {terminal ? <div className="node-footnote">Terminal node</div> : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
