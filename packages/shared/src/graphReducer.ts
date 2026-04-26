import type { BridgeEvent, MegaplanGraphScope, MegaplanGraphSnapshot } from './types';
import { assertAcyclic, getDownstreamNodeIds, upsertEdges, upsertGraphs, upsertNodes } from './graphUtils';

export function createEmptySnapshot(sessionId: string, bridgeBaseUrl?: string): MegaplanGraphSnapshot {
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    rootGraphId: 'root',
    focusedGraphId: 'root',
    phase: 'planning',
    graphs: [{
      id: 'root',
      title: 'Project graph',
      status: 'idle',
      createdAt: now,
      updatedAt: now
    }],
    nodes: [],
    edges: [],
    bridgeBaseUrl,
    eventLog: [],
    pendingToolUses: []
  };
}

export function reduceBridgeEvent(snapshot: MegaplanGraphSnapshot, event: BridgeEvent): MegaplanGraphSnapshot {
  if (event.type === 'sessionSnapshot') {
    assertAcyclic(event.snapshot.nodes, event.snapshot.edges);
    return withEventLog({ ...event.snapshot, updatedAt: event.timestamp }, event);
  }

  let next: MegaplanGraphSnapshot = {
    ...snapshot,
    updatedAt: event.timestamp
  };

  switch (event.type) {
    case 'nodesAdded': {
      next = {
        ...next,
        nodes: upsertNodes(next.nodes, event.nodes),
        edges: event.edges ? upsertEdges(next.edges, event.edges) : next.edges
      };
      break;
    }

    case 'nodesUpdated': {
      const patches = new Map(event.patches.map((patch) => [patch.id, patch.patch]));
      next = {
        ...next,
        nodes: next.nodes.filter((node) => !(event.removeIds ?? []).includes(node.id)).map((node) => {
          const patch = patches.get(node.id);
          return patch ? { ...node, ...patch } : node;
        }),
        activeNodeId: event.removeIds?.includes(next.activeNodeId ?? '') ? undefined : next.activeNodeId,
        pendingToolUses: (next.pendingToolUses ?? []).filter((toolUse) => !(event.removeIds ?? []).includes(toolUse.nodeId))
      };
      break;
    }

    case 'edgesUpdated': {
      next = {
        ...next,
        edges: upsertEdges(next.edges.filter((edge) => !(event.removeIds ?? []).includes(edge.id)), event.upsert ?? [])
      };
      break;
    }

    case 'graphsUpdated': {
      next = {
        ...next,
        graphs: upsertGraphs((next.graphs ?? []).filter((graph) => !(event.removeIds ?? []).includes(graph.id)), event.upsert ?? [])
      };
      break;
    }

    case 'activeNodeChanged': {
      next = {
        ...next,
        activeNodeId: event.activeNodeId
      };
      break;
    }

    case 'graphFocused': {
      next = {
        ...next,
        focusedGraphId: event.graphId
      };
      break;
    }

    case 'graphRunStateChanged': {
      next = {
        ...next,
        activeGraphId: event.status === 'running' ? event.graphId : next.activeGraphId === event.graphId ? undefined : next.activeGraphId,
        graphs: updateGraph(next.graphs ?? [], event.graphId, {
          status: event.status,
          summary: event.message,
          updatedAt: event.timestamp
        })
      };
      break;
    }

    case 'nodeInvalidated': {
      const impactedNodeIds = event.impactedNodeIds ?? getDownstreamNodeIds(event.nodeId, next.edges);
      const impacted = new Set([event.nodeId, ...impactedNodeIds]);
      next = {
        ...next,
        nodes: next.nodes.map((node) => impacted.has(node.id) ? { ...node, status: 'invalidated' } : node)
      };
      break;
    }

    case 'alternativesProposed': {
      next = {
        ...next,
        nodes: next.nodes.map((node) => node.id === event.nodeId ? { ...node, alternatives: event.alternatives } : node)
      };
      break;
    }

    case 'approvalRequested': {
      next = {
        ...next,
        pendingToolUses: upsertToolUses(next.pendingToolUses ?? [], [event.toolUse])
      };
      break;
    }

    case 'toolUseUpdated': {
      next = {
        ...next,
        pendingToolUses: (next.pendingToolUses ?? []).map((toolUse) => toolUse.id === event.toolUseId ? { ...toolUse, ...event.patch } : toolUse)
      };
      break;
    }

    case 'artifactLinked': {
      next = {
        ...next,
        nodes: next.nodes.map((node) => node.id === event.nodeId ? {
          ...node,
          artifacts: [...(node.artifacts ?? []), event.artifact]
        } : node)
      };
      break;
    }

    case 'agentError': {
      break;
    }

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }

  assertAcyclic(next.nodes, next.edges);
  return withEventLog(next, event);
}

function withEventLog(snapshot: MegaplanGraphSnapshot, event: BridgeEvent): MegaplanGraphSnapshot {
  const eventLog = [...(snapshot.eventLog ?? []), event].slice(-200);
  return { ...snapshot, eventLog };
}

function upsertToolUses(existing: NonNullable<MegaplanGraphSnapshot['pendingToolUses']>, incoming: NonNullable<MegaplanGraphSnapshot['pendingToolUses']>): NonNullable<MegaplanGraphSnapshot['pendingToolUses']> {
  const byId = new Map(existing.map((toolUse) => [toolUse.id, toolUse]));

  for (const toolUse of incoming) {
    byId.set(toolUse.id, { ...byId.get(toolUse.id), ...toolUse });
  }

  return Array.from(byId.values());
}

function updateGraph(graphs: MegaplanGraphScope[], graphId: string, patch: Partial<MegaplanGraphScope>): MegaplanGraphScope[] {
  if (graphs.some((graph) => graph.id === graphId)) {
    return graphs.map((graph) => graph.id === graphId ? { ...graph, ...patch } : graph);
  }

  return [...graphs, {
    id: graphId,
    title: graphId,
    status: patch.status ?? 'idle',
    createdAt: patch.updatedAt ?? new Date().toISOString(),
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
    summary: patch.summary
  }];
}
