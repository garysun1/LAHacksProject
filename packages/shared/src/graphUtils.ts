import type { MegaplanEdge, MegaplanGraphScope, MegaplanNode } from './types';

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

export function buildSequenceEdges(nodes: MegaplanNode[]): MegaplanEdge[] {
  const orderedNodes = nodes
    .map((node, index) => ({
      node,
      index,
      order: typeof node.order === 'number' ? node.order : index + 1
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index);
  const seen = new Set<string>();
  const uniqueNodes: MegaplanNode[] = [];

  for (const { node } of orderedNodes) {
    if (seen.has(node.id)) {
      continue;
    }

    seen.add(node.id);
    uniqueNodes.push(node);
  }

  return uniqueNodes.slice(1).map((node, index) => {
    const source = uniqueNodes[index].id;
    const target = node.id;
    return {
      id: `sequence-${source}-${target}`,
      source,
      target,
      kind: 'sequence'
    };
  });
}

export function getDownstreamNodeIds(startNodeId: string, edges: MegaplanEdge[]): string[] {
  const adjacency = new Map<string, string[]>();

  for (const edge of edges) {
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

export function upsertGraphs(existing: MegaplanGraphScope[], incoming: MegaplanGraphScope[]): MegaplanGraphScope[] {
  const byId = new Map(existing.map((graph) => [graph.id, graph]));

  for (const graph of incoming) {
    byId.set(graph.id, { ...byId.get(graph.id), ...graph });
  }

  return Array.from(byId.values());
}

export function getGraphNodes(graphId: string | undefined, nodes: MegaplanNode[]): MegaplanNode[] {
  const focusedGraphId = graphId ?? 'root';
  return nodes.filter((node) => (node.graphId ?? 'root') === focusedGraphId);
}

export function getGraphEdges(graphId: string | undefined, nodes: MegaplanNode[], edges: MegaplanEdge[]): MegaplanEdge[] {
  const nodeIds = new Set(getGraphNodes(graphId, nodes).map((node) => node.id));
  return edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
}

export function getGraphBreadcrumbs(graphId: string | undefined, graphs: MegaplanGraphScope[] = [], nodes: MegaplanNode[] = []): MegaplanGraphScope[] {
  const graphById = new Map(graphs.map((graph) => [graph.id, graph]));
  const nodeById = buildNodeMap(nodes);
  const breadcrumbs: MegaplanGraphScope[] = [];
  let current = graphById.get(graphId ?? 'root');

  while (current) {
    breadcrumbs.unshift(current);

    if (!current.parentNodeId) {
      break;
    }

    const parentNode = nodeById.get(current.parentNodeId);
    current = parentNode?.graphId ? graphById.get(parentNode.graphId) : graphById.get('root');
  }

  return breadcrumbs;
}
