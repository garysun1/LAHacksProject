import type { MegaplanEdge, MegaplanNode } from './types';

export function buildNodeMap(nodes: MegaplanNode[]): Map<string, MegaplanNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

export function hasCycle(nodes: MegaplanNode[], edges: MegaplanEdge[]): boolean {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      continue;
    }

    adjacency.get(edge.source)?.push(edge.target);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(nodeId: string): boolean {
    if (visiting.has(nodeId)) {
      return true;
    }

    if (visited.has(nodeId)) {
      return false;
    }

    visiting.add(nodeId);

    for (const targetId of adjacency.get(nodeId) ?? []) {
      if (visit(targetId)) {
        return true;
      }
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  }

  return Array.from(nodeIds).some((nodeId) => visit(nodeId));
}

export function assertAcyclic(nodes: MegaplanNode[], edges: MegaplanEdge[]): void {
  if (hasCycle(nodes, edges)) {
    throw new Error('Megaplan graph must be a DAG');
  }
}

export function getDownstreamNodeIds(startNodeId: string, edges: MegaplanEdge[]): string[] {
  const adjacency = new Map<string, string[]>();

  for (const edge of edges) {
    if (edge.kind !== 'dependency' && edge.kind !== 'entailment' && edge.kind !== 'sequence') {
      continue;
    }

    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }

  const impacted = new Set<string>();
  const queue = [...(adjacency.get(startNodeId) ?? [])];

  while (queue.length > 0) {
    const nodeId = queue.shift();

    if (!nodeId || impacted.has(nodeId)) {
      continue;
    }

    impacted.add(nodeId);
    queue.push(...(adjacency.get(nodeId) ?? []));
  }

  return Array.from(impacted);
}

export function upsertNodes(existing: MegaplanNode[], incoming: MegaplanNode[]): MegaplanNode[] {
  const byId = buildNodeMap(existing);

  for (const node of incoming) {
    byId.set(node.id, { ...byId.get(node.id), ...node });
  }

  return Array.from(byId.values());
}

export function upsertEdges(existing: MegaplanEdge[], incoming: MegaplanEdge[]): MegaplanEdge[] {
  const byId = new Map(existing.map((edge) => [edge.id, edge]));

  for (const edge of incoming) {
    byId.set(edge.id, { ...byId.get(edge.id), ...edge });
  }

  return Array.from(byId.values());
}
