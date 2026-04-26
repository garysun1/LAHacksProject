import { describe, expect, it } from 'vitest';
import { bridgeEventSchema } from './schemas';
import { createEmptySnapshot, reduceBridgeEvent } from './graphReducer';
import { buildSequenceEdges } from './graphUtils';
import type { BridgeEvent, MegaplanNode, ToolUseRequest } from './types';

const baseNode = (id: string): MegaplanNode => ({
  id,
  title: id,
  kind: 'task',
  phase: 'planning',
  status: 'pending'
});

const baseEvent = (type: BridgeEvent['type']): Pick<BridgeEvent, 'eventId' | 'sessionId' | 'timestamp' | 'type'> => ({
  type,
  eventId: `${type}-1`,
  sessionId: 'session-1',
  timestamp: '2026-01-01T00:00:00.000Z'
});

describe('reduceBridgeEvent', () => {
  it('builds repaired sequence edges from node order', () => {
    const nodes = [
      { ...baseNode('third'), order: 3 },
      { ...baseNode('first'), order: 1 },
      { ...baseNode('second'), order: 2 },
      { ...baseNode('second'), title: 'duplicate', order: 4 }
    ];

    expect(buildSequenceEdges(nodes)).toEqual([
      { id: 'sequence-first-second', source: 'first', target: 'second', kind: 'sequence' },
      { id: 'sequence-second-third', source: 'second', target: 'third', kind: 'sequence' }
    ]);
  });

  it('builds repaired sequence edges from array order when node order is missing', () => {
    expect(buildSequenceEdges([baseNode('first'), baseNode('second')])).toEqual([
      { id: 'sequence-first-second', source: 'first', target: 'second', kind: 'sequence' }
    ]);
  });

  it('adds nodes and edges', () => {
    const snapshot = createEmptySnapshot('session-1');
    const next = reduceBridgeEvent(snapshot, {
      ...baseEvent('nodesAdded'),
      type: 'nodesAdded',
      nodes: [baseNode('a'), baseNode('b')],
      edges: [{ id: 'a-b', source: 'a', target: 'b', kind: 'sequence' }]
    });

    expect(next.nodes).toHaveLength(2);
    expect(next.edges).toHaveLength(1);
  });

  it('rejects cyclic graphs', () => {
    const snapshot = createEmptySnapshot('session-1');

    expect(() => reduceBridgeEvent(snapshot, {
      ...baseEvent('nodesAdded'),
      type: 'nodesAdded',
      nodes: [baseNode('a'), baseNode('b')],
      edges: [
        { id: 'a-b', source: 'a', target: 'b', kind: 'sequence' },
        { id: 'b-a', source: 'b', target: 'a', kind: 'sequence' }
      ]
    })).toThrow('DAG');
  });

  it('invalidates downstream nodes', () => {
    const snapshot = reduceBridgeEvent(createEmptySnapshot('session-1'), {
      ...baseEvent('nodesAdded'),
      type: 'nodesAdded',
      nodes: [baseNode('a'), baseNode('b'), baseNode('c')],
      edges: [
        { id: 'a-b', source: 'a', target: 'b', kind: 'sequence' },
        { id: 'b-c', source: 'b', target: 'c', kind: 'sequence' }
      ]
    });

    const next = reduceBridgeEvent(snapshot, {
      ...baseEvent('nodeInvalidated'),
      type: 'nodeInvalidated',
      nodeId: 'a'
    });

    expect(next.nodes.map((node) => [node.id, node.status])).toEqual([
      ['a', 'invalidated'],
      ['b', 'invalidated'],
      ['c', 'invalidated']
    ]);
  });

  it('tracks approval requests and tool use status updates', () => {
    const toolUse: ToolUseRequest = {
      id: 'tool-1',
      kind: 'patch',
      nodeId: 'a',
      title: 'Write file',
      description: 'Write a proposed file.',
      path: 'src/file.ts',
      proposedContent: 'content',
      status: 'pending'
    };
    const approvalNode: MegaplanNode = {
      ...baseNode('approval-1'),
      kind: 'approval',
      status: 'blocked'
    };
    const snapshot = reduceBridgeEvent(createEmptySnapshot('session-1'), {
      ...baseEvent('approvalRequested'),
      type: 'approvalRequested',
      node: approvalNode,
      toolUse
    });
    const next = reduceBridgeEvent(snapshot, {
      ...baseEvent('toolUseUpdated'),
      type: 'toolUseUpdated',
      toolUseId: 'tool-1',
      patch: { status: 'applied' }
    });

    expect(next.pendingToolUses).toEqual([{ ...toolUse, status: 'applied' }]);
    expect(next.nodes.find((node) => node.id === 'approval-1')).toMatchObject({ kind: 'approval' });
  });

  it('tracks focused recursive graphs and run state', () => {
    const snapshot = createEmptySnapshot('session-1');
    const withGraph = reduceBridgeEvent(snapshot, {
      ...baseEvent('graphsUpdated'),
      type: 'graphsUpdated',
      upsert: [{
        id: 'graph-child',
        title: 'Child graph',
        parentNodeId: 'a',
        status: 'idle',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    });
    const focused = reduceBridgeEvent(withGraph, {
      ...baseEvent('graphFocused'),
      type: 'graphFocused',
      graphId: 'graph-child'
    });
    const running = reduceBridgeEvent(focused, {
      ...baseEvent('graphRunStateChanged'),
      type: 'graphRunStateChanged',
      graphId: 'graph-child',
      status: 'running'
    });
    const completed = reduceBridgeEvent(running, {
      ...baseEvent('graphRunStateChanged'),
      type: 'graphRunStateChanged',
      graphId: 'graph-child',
      status: 'completed',
      message: 'Graph completed.'
    });

    expect(focused.focusedGraphId).toBe('graph-child');
    expect(running.activeGraphId).toBe('graph-child');
    expect(completed.activeGraphId).toBeUndefined();
    expect(completed.graphs?.find((graph) => graph.id === 'graph-child')).toMatchObject({
      status: 'completed',
      summary: 'Graph completed.'
    });
  });

  it('links artifacts and clears active node without losing completed status', () => {
    const snapshot = reduceBridgeEvent(createEmptySnapshot('session-1'), {
      ...baseEvent('nodesAdded'),
      type: 'nodesAdded',
      nodes: [baseNode('a')]
    });
    const active = reduceBridgeEvent(snapshot, {
      ...baseEvent('activeNodeChanged'),
      type: 'activeNodeChanged',
      activeNodeId: 'a'
    });
    const completed = reduceBridgeEvent(active, {
      ...baseEvent('nodesUpdated'),
      type: 'nodesUpdated',
      patches: [{ id: 'a', patch: { status: 'completed' } }]
    });
    const cleared = reduceBridgeEvent(completed, {
      ...baseEvent('activeNodeChanged'),
      type: 'activeNodeChanged',
      activeNodeId: undefined
    });
    const withArtifact = reduceBridgeEvent(cleared, {
      ...baseEvent('artifactLinked'),
      type: 'artifactLinked',
      nodeId: 'a',
      artifact: {
        id: 'artifact-1',
        kind: 'observation',
        title: 'Observation',
        content: 'done'
      }
    });

    expect(withArtifact.activeNodeId).toBeUndefined();
    expect(withArtifact.nodes[0]).toMatchObject({
      status: 'completed',
      artifacts: [{ id: 'artifact-1', kind: 'observation' }]
    });
  });

  it('bounds event log history', () => {
    let snapshot = createEmptySnapshot('session-1');

    for (let index = 0; index < 205; index += 1) {
      snapshot = reduceBridgeEvent(snapshot, {
        type: 'agentError',
        eventId: `error-${index}`,
        sessionId: 'session-1',
        timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        message: 'error'
      });
    }

    expect(snapshot.eventLog).toHaveLength(200);
    expect(snapshot.eventLog?.[0]?.eventId).toBe('error-5');
  });

  it('validates tool use update events through the shared schema', () => {
    expect(bridgeEventSchema.parse({
      ...baseEvent('toolUseUpdated'),
      type: 'toolUseUpdated',
      toolUseId: 'tool-1',
      patch: { status: 'rejected' }
    })).toMatchObject({ type: 'toolUseUpdated' });
  });

  it('validates recursive graph commands through the shared schema', () => {
    expect(bridgeEventSchema.parse({
      ...baseEvent('graphRunStateChanged'),
      type: 'graphRunStateChanged',
      graphId: 'root',
      status: 'running'
    })).toMatchObject({ type: 'graphRunStateChanged' });
  });
});
