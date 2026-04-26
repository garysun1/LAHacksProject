import { useMemo } from 'react';
import { Background, Controls, ReactFlow, type Edge, type NodeTypes } from '@xyflow/react';
import type { MegaplanGraphSnapshot, MegaplanNode as MegaplanNodeData } from '@megaplan/shared';
import { MegaplanNode, type MegaplanFlowNode } from './MegaplanNode';

const nodeTypes = {
  megaplan: MegaplanNode
} satisfies NodeTypes;

type Props = {
  snapshot: MegaplanGraphSnapshot;
  selectedNodeId?: string;
  impactedNodeIds: string[];
  onSelectNode: (nodeId: string) => void;
  onOpenNodeGraph: (nodeId: string) => void;
};

export function MegaplanGraph({ snapshot, selectedNodeId, impactedNodeIds, onSelectNode, onOpenNodeGraph }: Props): JSX.Element {
  const impacted = useMemo(() => new Set(impactedNodeIds), [impactedNodeIds]);

  const nodes = useMemo<MegaplanFlowNode[]>(() => {
    return snapshot.nodes.map((node) => ({
      id: node.id,
      type: 'megaplan',
      position: getNodePosition(node, snapshot.nodes),
      data: {
        ...node,
        active: snapshot.activeNodeId === node.id,
        impacted: impacted.has(node.id),
        selected: selectedNodeId === node.id,
        onInspect: onSelectNode
      }
    }));
  }, [impacted, onSelectNode, selectedNodeId, snapshot.activeNodeId, snapshot.nodes]);

  const edges = useMemo<Edge[]>(() => {
    return snapshot.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      className: 'edge-sequence'
    }));
  }, [snapshot.edges]);

  return (
    <ReactFlow<MegaplanFlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onNodeDoubleClick={(_, node) => {
        if (node.data.abstraction !== 'terminal' && node.data.abstraction !== 'runnable' && node.data.expandable !== false) {
          onOpenNodeGraph(node.id);
        }
      }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

function getNodePosition(node: MegaplanNodeData, nodes: MegaplanNodeData[]): { x: number; y: number } {
  const orderedNodes = [...nodes]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const nodeIndex = Math.max(0, orderedNodes.findIndex((candidate) => candidate.id === node.id));

  return {
    x: 0,
    y: nodeIndex * 150
  };
}
