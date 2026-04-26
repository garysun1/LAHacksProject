import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, MegaplanEdge, MegaplanNode } from '@megaplan/shared';
import type { OpenAiAgent } from '../openai/OpenAiAgent';
import { AgentSession } from './AgentSession';

const tempDirs: string[] = [];

const planNode = (overrides: Partial<MegaplanNode> = {}): MegaplanNode => ({
  id: 'node-1',
  title: 'Implement change',
  kind: 'action',
  phase: 'execution',
  status: 'pending',
  ...overrides
});

describe('AgentSession', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  it('emits a fallback-style snapshot and visible patch approval status updates', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNode: planNode(),
      execution: {
        summary: 'Patch is ready.',
        rationale: 'The file should be written after approval.',
        confidence: 0.7,
        observations: ['Inspected workspace.'],
        proposedPatch: {
          path: 'src/generated.ts',
          content: 'export const generated = true;\n',
          description: 'Create generated file.'
        }
      }
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create file',
      workspaceRoot
    });
    await session.handleCommand({
      type: 'runGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      graphId: 'root'
    });
    await flushAsyncWork();

    const approval = events.find((event): event is Extract<BridgeEvent, { type: 'approvalRequested' }> => event.type === 'approvalRequested');
    expect(approval?.toolUse.status).toBe('pending');
    expect(events.some((event) => event.type === 'activeNodeChanged' && event.activeNodeId === undefined)).toBe(true);
    await expect(fs.readFile(path.join(workspaceRoot, 'src/generated.ts'), 'utf8')).rejects.toThrow();

    await session.handleCommand({
      type: 'approveToolUse',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      toolUseId: approval?.toolUse.id ?? ''
    });
    await flushAsyncWork();

    expect(events.filter((event) => event.type === 'toolUseUpdated').map((event) => event.patch.status)).toEqual(['approved', 'applied']);
    await expect(fs.readFile(path.join(workspaceRoot, 'src/generated.ts'), 'utf8')).resolves.toBe('export const generated = true;\n');
    expect(session.getSnapshot().pendingToolUses?.[0]?.status).toBe('applied');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')?.status).toBe('completed');
  });

  it('rejects tool use through bridge events and invalidates downstream nodes', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNode: planNode(),
      execution: {
        summary: 'Patch is ready.',
        rationale: 'The file should be written after approval.',
        confidence: 0.7,
        observations: [],
        proposedPatch: {
          path: 'src/rejected.ts',
          content: 'export const rejected = true;\n',
          description: 'Create rejected file.'
        }
      }
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create file',
      workspaceRoot
    });
    await session.handleCommand({
      type: 'runGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      graphId: 'root'
    });
    await flushAsyncWork();

    const approval = events.find((event): event is Extract<BridgeEvent, { type: 'approvalRequested' }> => event.type === 'approvalRequested');
    await session.handleCommand({
      type: 'rejectToolUse',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      toolUseId: approval?.toolUse.id ?? '',
      reason: 'Not wanted.'
    });

    expect(events.some((event) => event.type === 'toolUseUpdated' && event.patch.status === 'rejected')).toBe(true);
    expect(session.getSnapshot().pendingToolUses?.[0]?.status).toBe('rejected');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')?.status).toBe('invalidated');
    await expect(fs.readFile(path.join(workspaceRoot, 'src/rejected.ts'), 'utf8')).rejects.toThrow();
  });

  it('repairs cyclic root proposal edges into ordered sequence edges', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [
        planNode({ id: 'third', title: 'Third', order: 3, abstraction: 'terminal' }),
        planNode({ id: 'first', title: 'First', order: 1, abstraction: 'terminal' }),
        planNode({ id: 'second', title: 'Second', order: 2, abstraction: 'terminal' })
      ],
      planEdges: [
        { id: 'third-first', source: 'third', target: 'first', kind: 'sequence' },
        { id: 'first-second', source: 'first', target: 'second', kind: 'sequence' },
        { id: 'second-third', source: 'second', target: 'third', kind: 'sequence' }
      ],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create ordered plan'
    });

    expect(events.find((event) => event.type === 'sessionSnapshot')).toMatchObject({
      type: 'sessionSnapshot',
      snapshot: {
        edges: [
          { id: 'sequence-first-second', source: 'first', target: 'second', kind: 'sequence' },
          { id: 'sequence-second-third', source: 'second', target: 'third', kind: 'sequence' }
        ]
      }
    });
  });

  it('opens any node as an empty child graph before running it', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [planNode({ expandable: false, abstraction: 'terminal' })],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create parent plan'
    });
    await session.handleCommand({
      type: 'decomposeNode',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });

    expect(session.getSnapshot().focusedGraphId).toBe('graph-node-1');
    expect(session.getSnapshot().graphs?.find((graph) => graph.id === 'graph-node-1')?.parentNodeId).toBe('node-1');
    expect(session.getSnapshot().nodes.filter((node) => node.graphId === 'graph-node-1')).toEqual([]);

    await session.handleCommand({
      type: 'runGraph',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'graph-node-1'
    });

    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      status: 'completed',
      summary: 'Done.'
    });
  });

  it('repairs cyclic child proposal edges when running an empty decomposable child graph', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [planNode({ expandable: true, abstraction: 'decomposable' })],
      planEdges: [],
      decomposeNodes: [
        planNode({ id: 'child-b', title: 'Child B', order: 2, abstraction: 'terminal' }),
        planNode({ id: 'child-a', title: 'Child A', order: 1, abstraction: 'terminal' })
      ],
      decomposeEdges: [
        { id: 'b-a', source: 'child-b', target: 'child-a', kind: 'sequence' },
        { id: 'a-b', source: 'child-a', target: 'child-b', kind: 'sequence' }
      ],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create parent plan'
    });
    await session.handleCommand({
      type: 'decomposeNode',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });
    await session.handleCommand({
      type: 'runGraph',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'graph-node-1'
    });

    expect(events.find((event): event is Extract<BridgeEvent, { type: 'nodesAdded' }> => event.type === 'nodesAdded')?.edges).toEqual([
      { id: 'sequence-child-a-child-b', source: 'child-a', target: 'child-b', kind: 'sequence' }
    ]);
  });
});

function createAgent({
  planNode,
  planNodes,
  planEdges = [],
  decomposeNodes = [],
  decomposeEdges = [],
  execution
}: {
  planNode?: MegaplanNode;
  planNodes?: MegaplanNode[];
  planEdges?: MegaplanEdge[];
  decomposeNodes?: MegaplanNode[];
  decomposeEdges?: MegaplanEdge[];
  execution: Awaited<ReturnType<OpenAiAgent['executeNode']>>;
}): OpenAiAgent {
  return {
    configured: false,
    planTask: async () => ({ nodes: planNodes ?? (planNode ? [planNode] : []), edges: planEdges }),
    decomposeNode: async () => ({ nodes: decomposeNodes, edges: decomposeEdges }),
    executeNode: async () => execution
  } as unknown as OpenAiAgent;
}

function completedExecution(): Awaited<ReturnType<OpenAiAgent['executeNode']>> {
  return {
    summary: 'Done.',
    rationale: 'Completed in test.',
    confidence: 1,
    observations: []
  };
}

async function makeTempWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'megaplan-session-'));
  tempDirs.push(directory);
  await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  await fs.writeFile(path.join(directory, 'src/existing.ts'), 'export const existing = true;\n', 'utf8');
  return directory;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
