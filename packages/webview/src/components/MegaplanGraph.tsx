import { useMemo } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type NodeTypes } from '@xyflow/react';
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
  onExpandNode: (nodeId: string) => void;
  onFocusGraph: (graphId: string) => void;
};

export function MegaplanGraph({ snapshot, selectedNodeId, impactedNodeIds, onSelectNode, onExpandNode, onFocusGraph }: Props): JSX.Element {
  const impacted = useMemo(() => new Set(impactedNodeIds), [impactedNodeIds]);

  const nodes = useMemo<MegaplanFlowNode[]>(() => {
    return snapshot.nodes.map((node) => ({
      id: node.id,
      type: 'megaplan',
      position: getNodePosition(node, snapshot.nodes),
      data: {
        ...node,
        impacted: impacted.has(node.id),
        selected: selectedNodeId === node.id,
        onInspect: onSelectNode,
        onExpand: onExpandNode,
        onFocusGraph
      }
    }));
  }, [impacted, onExpandNode, onFocusGraph, onSelectNode, selectedNodeId, snapshot.nodes]);

  const edges = useMemo<Edge[]>(() => {
    return snapshot.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.kind,
      animated: edge.kind === 'invalidates',
      className: `edge-${edge.kind}`
    }));
  }, [snapshot.edges]);

  return (
    <ReactFlow<MegaplanFlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      onNodeClick={(_, node) => onSelectNode(node.id)}
    >
      <Background />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}

function getNodePosition(node: MegaplanNodeData, nodes: MegaplanNodeData[]): { x: number; y: number } {
  const phaseX: Record<MegaplanNodeData['phase'], number> = {
    planning: 0,
    execution: 360,
    review: 720
  };
  const siblings = nodes
    .filter((candidate) => candidate.parentId === node.parentId && candidate.phase === node.phase)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const siblingIndex = Math.max(0, siblings.findIndex((candidate) => candidate.id === node.id));
  const depth = getDepth(node, nodes);

  return {
    x: phaseX[node.phase] + depth * 80,
    y: siblingIndex * 180 + depth * 45
  };
}

function getDepth(node: MegaplanNodeData, nodes: MegaplanNodeData[]): number {
  let depth = 0;
  let current = node;

  while (current.parentId) {
    const parent = nodes.find((candidate) => candidate.id === current.parentId);

    if (!parent) {
      break;
    }

    current = parent;
    depth += 1;
  }

  return depth;
}
