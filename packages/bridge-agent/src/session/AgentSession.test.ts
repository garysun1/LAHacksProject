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
  summary: 'Implement change.',
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
    expect(session.getSnapshot().nodes.filter((node) => node.kind === 'approval')).toEqual([]);
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      status: 'blocked',
      summary: 'Approval required: Write src/generated.ts'
    });
    expect(session.getSnapshot().activeNodeId).toBe('node-1');
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
    expect(session.getSnapshot().activeNodeId).toBeUndefined();
  });

  it('resumes a graph run at the next node after approving a graph-run tool use', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const events: BridgeEvent[] = [];
    let executionCount = 0;
    const agent = createAgent({
      planNodes: [
        planNode({ id: 'first', title: 'Write generated file', order: 1, abstraction: 'terminal' }),
        planNode({ id: 'second', title: 'Validate generated file', kind: 'review', order: 2, abstraction: 'terminal' })
      ],
      planEdges: [{ id: 'first-second', source: 'first', target: 'second', kind: 'sequence' }],
      execution: completedExecution(),
      executeNode: async (node) => {
        executionCount += 1;

        if (node.id === 'first') {
          return {
            summary: 'Patch is ready.',
            rationale: 'The file should be written after approval.',
            confidence: 0.7,
            observations: [],
            proposedPatch: {
              path: 'src/resume.ts',
              content: 'export const resume = true;\n',
              description: 'Create resume file.'
            }
          };
        }

        return completedExecution();
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

    expect(session.getSnapshot().nodes.find((node) => node.id === 'first')?.status).toBe('blocked');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'second')?.status).toBe('pending');

    const approval = session.getSnapshot().pendingToolUses?.[0];
    await session.handleCommand({
      type: 'approveToolUse',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      toolUseId: approval?.id ?? ''
    });

    await expect(fs.readFile(path.join(workspaceRoot, 'src/resume.ts'), 'utf8')).resolves.toBe('export const resume = true;\n');
    expect(session.getSnapshot().nodes.map((node) => [node.id, node.status])).toEqual([
      ['first', 'completed'],
      ['second', 'completed']
    ]);
    expect(executionCount).toBe(2);
    expect(events.filter((event) => event.type === 'approvalRequested')).toHaveLength(1);
    const activeNodeIds = events
      .filter((event): event is Extract<BridgeEvent, { type: 'activeNodeChanged' }> => event.type === 'activeNodeChanged')
      .map((event) => event.activeNodeId);
    expect(activeNodeIds.lastIndexOf('second')).toBeGreaterThan(activeNodeIds.indexOf('first'));
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

  it('selects an alternative by replacing the displayed node details', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNode: planNode({
        kind: 'decision',
        alternatives: [
          { id: 'fast', title: 'Fast path', summary: 'Ship the smallest safe change.', tradeoffs: ['Lower scope'], recommended: true },
          { id: 'deep', title: 'Deep path', summary: 'Refactor the underlying module.', tradeoffs: ['More complete', 'More risk'] }
        ]
      }),
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Choose approach'
    });
    await session.handleCommand({
      type: 'selectAlternative',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1',
      alternativeId: 'deep'
    });

    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      title: 'Deep path',
      summary: 'Refactor the underlying module.',
      rationale: 'Selected alternative tradeoffs: More complete · More risk',
      selectedAlternativeId: 'deep',
      alternatives: [
        expect.objectContaining({ id: 'fast' }),
        expect.objectContaining({ id: 'deep', status: 'selected' })
      ]
    });
    expect(events.some((event) => event.type === 'graphsUpdated')).toBe(false);
    expect(events.some((event) => event.type === 'nodesAdded' && event.nodes.some((node) => node.graphId === 'graph-node-1-alt-deep'))).toBe(false);
  });

  it('keeps pending approval usable after selecting an alternative on the blocked node', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNode: planNode({
        alternatives: [
          { id: 'small', title: 'Small patch', summary: 'Apply the small patch.', tradeoffs: ['Less surface area'] },
          { id: 'large', title: 'Large patch', summary: 'Apply the broader patch.', tradeoffs: ['More coverage'] }
        ]
      }),
      execution: {
        summary: 'Patch is ready.',
        rationale: 'The file should be written after approval.',
        confidence: 0.7,
        observations: [],
        proposedPatch: {
          path: 'src/alternative.ts',
          content: 'export const alternative = true;\n',
          description: 'Create alternative file.'
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

    const approval = events.find((event): event is Extract<BridgeEvent, { type: 'approvalRequested' }> => event.type === 'approvalRequested');
    await session.handleCommand({
      type: 'selectAlternative',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      nodeId: 'node-1',
      alternativeId: 'large'
    });

    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      title: 'Large patch',
      summary: 'Apply the broader patch.',
      status: 'blocked',
      selectedAlternativeId: 'large'
    });
    expect(session.getSnapshot().pendingToolUses?.[0]).toMatchObject({
      id: approval?.toolUse.id,
      nodeId: 'node-1',
      status: 'pending'
    });

    await session.handleCommand({
      type: 'approveToolUse',
      commandId: 'cmd-4',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      toolUseId: approval?.toolUse.id ?? ''
    });

    await expect(fs.readFile(path.join(workspaceRoot, 'src/alternative.ts'), 'utf8')).resolves.toBe('export const alternative = true;\n');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')?.status).toBe('completed');
    expect(session.getSnapshot().activeNodeId).toBeUndefined();
  });

  it('resumes the graph after selecting an alternative and approving its graph-run tool use', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [
        planNode({
          id: 'first',
          title: 'Write selected file',
          order: 1,
          abstraction: 'terminal',
          alternatives: [
            { id: 'small', title: 'Small patch', summary: 'Apply the small patch.', tradeoffs: ['Less surface area'] },
            { id: 'large', title: 'Large patch', summary: 'Apply the broader patch.', tradeoffs: ['More coverage'] }
          ]
        }),
        planNode({ id: 'second', title: 'Validate selected file', kind: 'review', order: 2, abstraction: 'terminal' })
      ],
      planEdges: [{ id: 'first-second', source: 'first', target: 'second', kind: 'sequence' }],
      execution: completedExecution(),
      executeNode: async (node) => {
        if (node.id === 'first') {
          return {
            summary: 'Patch is ready.',
            rationale: 'The file should be written after approval.',
            confidence: 0.7,
            observations: [],
            proposedPatch: {
              path: 'src/selected-alternative.ts',
              content: 'export const selectedAlternative = true;\n',
              description: 'Create selected alternative file.'
            }
          };
        }

        return completedExecution();
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

    const approval = session.getSnapshot().pendingToolUses?.[0];
    await session.handleCommand({
      type: 'selectAlternative',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      nodeId: 'first',
      alternativeId: 'large'
    });
    await session.handleCommand({
      type: 'approveToolUse',
      commandId: 'cmd-4',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      toolUseId: approval?.id ?? ''
    });

    expect(session.getSnapshot().nodes.map((node) => [node.id, node.status])).toEqual([
      ['first', 'completed'],
      ['second', 'completed']
    ]);
    expect(session.getSnapshot().nodes.find((node) => node.id === 'first')).toMatchObject({
      title: 'Large patch',
      selectedAlternativeId: 'large'
    });
    await expect(fs.readFile(path.join(workspaceRoot, 'src/selected-alternative.ts'), 'utf8')).resolves.toBe('export const selectedAlternative = true;\n');
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
      type: 'constructGraph',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      graphId: 'root',
      instructions: 'Create ordered plan'
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

  it('runs the displayed graph in order while highlighting completed nodes', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [
        planNode({ id: 'first', title: 'Review completed setup', status: 'completed', order: 1, abstraction: 'terminal' }),
        planNode({ id: 'second', title: 'Implement remaining change', order: 2, abstraction: 'terminal' })
      ],
      planEdges: [{ id: 'first-second', source: 'first', target: 'second', kind: 'sequence' }],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      graphId: 'root',
      instructions: 'Create ordered plan'
    });
    await session.handleCommand({
      type: 'runGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      graphId: 'root'
    });

    const activeNodeIds = events
      .filter((event): event is Extract<BridgeEvent, { type: 'activeNodeChanged' }> => event.type === 'activeNodeChanged')
      .map((event) => event.activeNodeId);
    expect(activeNodeIds).toEqual(expect.arrayContaining(['first', 'second']));
    expect(activeNodeIds.indexOf('first')).toBeLessThan(activeNodeIds.indexOf('second'));
    expect(session.getSnapshot().nodes.map((node) => [node.id, node.status])).toEqual([
      ['first', 'completed'],
      ['second', 'completed']
    ]);
  });

  it('enters a populated child graph while running the displayed graph', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [
        planNode({ id: 'parent', title: 'Implement parent step', status: 'completed', expandable: true, abstraction: 'decomposable', order: 1 }),
        planNode({ id: 'sibling', title: 'Validate parent step', kind: 'review', order: 2, abstraction: 'terminal' })
      ],
      planEdges: [{ id: 'parent-sibling', source: 'parent', target: 'sibling', kind: 'sequence' }],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      graphId: 'root',
      instructions: 'Create ordered plan'
    });

    const snapshot = session.getSnapshot();
    const now = '2026-01-01T00:00:01.000Z';
    snapshot.graphs?.push({
      id: 'graph-parent',
      title: 'Implement parent step',
      parentNodeId: 'parent',
      status: 'idle',
      createdAt: now,
      updatedAt: now
    });
    Object.assign(snapshot.nodes.find((node) => node.id === 'parent') ?? {}, {
      childGraphId: 'graph-parent',
      expanded: true
    });
    snapshot.nodes.push(
      planNode({ id: 'child-a', title: 'Inspect parent implementation', graphId: 'graph-parent', parentId: 'parent', status: 'completed', order: 1, abstraction: 'terminal' }),
      planNode({ id: 'child-b', title: 'Update parent implementation', graphId: 'graph-parent', parentId: 'parent', order: 2, abstraction: 'terminal' })
    );
    snapshot.edges.push({ id: 'sequence-child-a-child-b', source: 'child-a', target: 'child-b', kind: 'sequence' });

    await session.handleCommand({
      type: 'runGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'root'
    });

    const focusedGraphIds = events
      .filter((event): event is Extract<BridgeEvent, { type: 'graphFocused' }> => event.type === 'graphFocused')
      .map((event) => event.graphId);
    expect(focusedGraphIds).toEqual(expect.arrayContaining(['graph-parent', 'root']));
    expect(focusedGraphIds.indexOf('graph-parent')).toBeLessThan(focusedGraphIds.lastIndexOf('root'));

    const activeNodeIds = events
      .filter((event): event is Extract<BridgeEvent, { type: 'activeNodeChanged' }> => event.type === 'activeNodeChanged')
      .map((event) => event.activeNodeId);
    expect(activeNodeIds).toEqual(expect.arrayContaining(['parent', 'child-a', 'child-b', 'sibling']));
    expect(activeNodeIds.indexOf('child-a')).toBeLessThan(activeNodeIds.indexOf('child-b'));
    expect(activeNodeIds.indexOf('child-b')).toBeLessThan(activeNodeIds.indexOf('sibling'));
    expect(session.getSnapshot().nodes.find((node) => node.id === 'child-b')?.status).toBe('completed');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'sibling')?.status).toBe('completed');
    expect(session.getSnapshot().focusedGraphId).toBe('root');
  });

  it('replaces non-coding root proposals with coding-agent phases when the model is configured', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      configured: true,
      planNodes: [
        planNode({ id: 'stakeholder-a', title: 'Identify stakeholder groups', summary: 'List business stakeholders.', order: 1 }),
        planNode({ id: 'stakeholder-b', title: 'Conduct stakeholder interviews', summary: 'Gather project input.', order: 2 }),
        planNode({ id: 'stakeholder-c', title: 'Create stakeholder map', summary: 'Categorize influence.', order: 3 })
      ],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      graphId: 'root',
      instructions: 'Create an AI girlfriend app'
    });

    expect(session.getSnapshot().nodes.map((node) => node.title)).toEqual([
      'Inspect codebase and task context',
      'Design implementation approach',
      'Implement code changes',
      'Validate with tests and build'
    ]);
    expect(events.find((event) => event.type === 'sessionSnapshot')).toMatchObject({
      type: 'sessionSnapshot',
      snapshot: {
        edges: [
          { id: 'sequence-plan-inspect-codebase-plan-design-code-changes', source: 'plan-inspect-codebase', target: 'plan-design-code-changes', kind: 'sequence' },
          { id: 'sequence-plan-design-code-changes-plan-implement-code-changes', source: 'plan-design-code-changes', target: 'plan-implement-code-changes', kind: 'sequence' },
          { id: 'sequence-plan-implement-code-changes-plan-validate-build', source: 'plan-implement-code-changes', target: 'plan-validate-build', kind: 'sequence' }
        ]
      }
    });
  });

  it('replaces AI research root proposals with coding-agent phases when the model is configured', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      configured: true,
      planNodes: [
        planNode({ id: 'research-a', title: 'Inspect Current AI Technologies', summary: 'Survey available AI model approaches.', order: 1 }),
        planNode({ id: 'research-b', title: 'Review AI Model Architecture', summary: 'Review transformer model architectures.', order: 2 }),
        planNode({ id: 'research-c', title: 'Analyze Transformer Architectures', summary: 'Evaluate transformer components for conversational AI.', order: 3 })
      ],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      graphId: 'root',
      instructions: 'Create an AI girlfriend app'
    });

    expect(session.getSnapshot().nodes.map((node) => node.title)).toEqual([
      'Inspect codebase and task context',
      'Design implementation approach',
      'Implement code changes',
      'Validate with tests and build'
    ]);
  });

  it('does not open terminal nodes as child graphs and still runs them directly', async () => {
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
      type: 'openNodeGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });

    expect(session.getSnapshot().focusedGraphId).toBe('root');
    expect(session.getSnapshot().graphs?.find((graph) => graph.id === 'graph-node-1')).toBeUndefined();
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      abstraction: 'terminal',
      expandable: false
    });

    await session.handleCommand({
      type: 'runNode',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      nodeId: 'node-1'
    });

    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      status: 'completed',
      summary: 'Done.'
    });
  });

  it('runs a terminal node directly when its child graph is empty', async () => {
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
      type: 'openNodeGraph',
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
      graphId: 'root'
    });

    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      status: 'completed',
      summary: 'Done.'
    });
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')?.summary).not.toContain('Construct it or run the node directly.');
    expect(events.some((event) => event.type === 'nodesUpdated' && event.patches.some((patch) => patch.patch.status === 'blocked'))).toBe(false);
  });

  it('revalidates a completed selected node subtree without running parent graph siblings', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [
        planNode({ status: 'completed', expandable: true, abstraction: 'decomposable', order: 1 }),
        planNode({ id: 'node-2', title: 'Validate unrelated root step', kind: 'review', order: 2, abstraction: 'terminal' })
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

    const snapshot = session.getSnapshot();
    const now = '2026-01-01T00:00:01.000Z';
    snapshot.graphs?.push({
      id: 'graph-node-1',
      title: 'Implement change',
      parentNodeId: 'node-1',
      status: 'idle',
      createdAt: now,
      updatedAt: now
    });
    Object.assign(snapshot.nodes.find((node) => node.id === 'node-1') ?? {}, {
      childGraphId: 'graph-node-1',
      expanded: true
    });
    snapshot.nodes.push(
      planNode({ id: 'child-a', title: 'Inspect completed child work', graphId: 'graph-node-1', parentId: 'node-1', status: 'completed', order: 1, abstraction: 'terminal' }),
      planNode({ id: 'child-b', title: 'Add newly inserted child step', graphId: 'graph-node-1', parentId: 'node-1', order: 2, abstraction: 'terminal' })
    );
    snapshot.edges.push({ id: 'sequence-child-a-child-b', source: 'child-a', target: 'child-b', kind: 'sequence' });

    await session.handleCommand({
      type: 'runNode',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      nodeId: 'node-1'
    });

    const activeNodeIds = events
      .filter((event): event is Extract<BridgeEvent, { type: 'activeNodeChanged' }> => event.type === 'activeNodeChanged')
      .map((event) => event.activeNodeId);
    expect(activeNodeIds).toEqual(expect.arrayContaining(['node-1', 'child-a', 'child-b']));
    expect(activeNodeIds.indexOf('child-a')).toBeLessThan(activeNodeIds.indexOf('child-b'));
    expect(session.getSnapshot().nodes.find((node) => node.id === 'child-b')).toMatchObject({
      status: 'completed',
      summary: 'Done.'
    });
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      status: 'completed',
      summary: 'Completed subgraph graph-node-1.'
    });
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-2')?.status).toBe('pending');
    expect(session.getSnapshot()).toMatchObject({
      focusedGraphId: 'root',
      activeNodeId: 'node-1'
    });
  });

  it('repairs cyclic child proposal edges when constructing an empty decomposable child graph', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [planNode({ expandable: true, abstraction: 'decomposable' })],
      planEdges: [],
      decomposeNodes: [
        planNode({ id: 'child-b', title: 'Update session execution logic', order: 2, abstraction: 'terminal' }),
        planNode({ id: 'child-a', title: 'Inspect bridge-agent files', order: 1, abstraction: 'terminal' })
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
      type: 'openNodeGraph',
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
    expect(events.some((event) => event.type === 'nodesAdded' && event.nodes.some((node) => node.graphId === 'graph-node-1'))).toBe(false);

    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-4',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      graphId: 'graph-node-1',
      instructions: 'Use two child steps.'
    });

    expect(events.find((event): event is Extract<BridgeEvent, { type: 'nodesAdded' }> => event.type === 'nodesAdded')?.edges).toEqual([
      { id: 'sequence-child-a-child-b', source: 'child-a', target: 'child-b', kind: 'sequence' }
    ]);
    expect(events.some((event) => event.type === 'graphRunStateChanged' && event.graphId === 'graph-node-1' && event.message === 'No nodes to run. Construct this graph first.')).toBe(true);

    await session.handleCommand({
      type: 'runNode',
      commandId: 'cmd-5',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:04.000Z',
      nodeId: 'node-1'
    });

    expect(session.getSnapshot().nodes.filter((node) => node.graphId === 'graph-node-1').map((node) => [node.id, node.status])).toEqual([
      ['child-b', 'completed'],
      ['child-a', 'completed']
    ]);
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      status: 'completed',
      summary: 'Completed subgraph graph-node-1.'
    });
    expect(session.getSnapshot()).toMatchObject({
      focusedGraphId: 'root',
      activeNodeId: 'node-1'
    });
  });

  it('keeps the approval-blocked child highlighted while marking the parent blocked', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [planNode({ expandable: true, abstraction: 'decomposable' })],
      planEdges: [],
      decomposeNodes: [
        planNode({ id: 'child-a', title: 'Update generated file', order: 1, abstraction: 'terminal' }),
        planNode({ id: 'child-b', title: 'Validate generated file tests', kind: 'review', order: 2, abstraction: 'terminal' })
      ],
      execution: {
        summary: 'Patch is ready.',
        rationale: 'The file should be written after approval.',
        confidence: 0.7,
        observations: [],
        proposedPatch: {
          path: 'src/generated-child.ts',
          content: 'export const generatedChild = true;\n',
          description: 'Create generated child file.'
        }
      }
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create parent plan',
      workspaceRoot
    });
    await session.handleCommand({
      type: 'openNodeGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });
    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'graph-node-1'
    });
    await session.handleCommand({
      type: 'runNode',
      commandId: 'cmd-4',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      nodeId: 'node-1'
    });

    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      status: 'blocked'
    });
    expect(session.getSnapshot().nodes.find((node) => node.id === 'child-a')).toMatchObject({
      status: 'blocked',
      summary: 'Approval required: Write src/generated-child.ts'
    });
    expect(session.getSnapshot()).toMatchObject({
      focusedGraphId: 'graph-node-1',
      activeNodeId: 'child-a'
    });
    expect(session.getSnapshot().pendingToolUses?.[0]).toMatchObject({
      nodeId: 'child-a',
      status: 'pending'
    });
    expect(events.some((event) => event.type === 'graphRunStateChanged' && event.graphId === 'graph-node-1' && event.status === 'blocked')).toBe(true);

    const approval = session.getSnapshot().pendingToolUses?.[0];
    await session.handleCommand({
      type: 'approveToolUse',
      commandId: 'cmd-5',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:04.000Z',
      toolUseId: approval?.id ?? ''
    });
    await flushAsyncWork();

    expect(session.getSnapshot().nodes.find((node) => node.id === 'child-a')?.status).toBe('completed');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'child-b')?.status).toBe('pending');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')?.status).toBe('pending');
    expect(events.filter((event) => event.type === 'approvalRequested')).toHaveLength(1);
  });

  it('returns to the parent graph when a node is unambiguous and needs no child steps', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [planNode({ expandable: true, abstraction: 'decomposable' })],
      planEdges: [],
      decomposeNodes: [],
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
      type: 'openNodeGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });
    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'graph-node-1'
    });

    expect(session.getSnapshot().focusedGraphId).toBe('root');
    expect(session.getSnapshot().nodes.filter((node) => node.graphId === 'graph-node-1')).toEqual([]);
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      abstraction: 'terminal',
      expandable: false,
      expanded: false,
      status: 'pending',
      summary: 'Unambiguous terminal step; no child graph needed.'
    });
    expect(events.some((event) => event.type === 'graphRunStateChanged' && event.graphId === 'graph-node-1' && event.message === 'No child steps needed.')).toBe(true);
  });

  it('terminalizes non-coding child proposals for coding tasks', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [planNode({ title: 'Implement chat feature', expandable: true, abstraction: 'decomposable' })],
      planEdges: [],
      decomposeNodes: [
        planNode({ id: 'stakeholder-a', title: 'Identify stakeholder groups', summary: 'List business stakeholders.', order: 1 }),
        planNode({ id: 'stakeholder-b', title: 'Conduct stakeholder interviews', summary: 'Gather project input.', order: 2 }),
        planNode({ id: 'stakeholder-c', title: 'Create stakeholder map', summary: 'Categorize influence.', order: 3 })
      ],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create an AI girlfriend app'
    });
    await session.handleCommand({
      type: 'openNodeGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });
    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'graph-node-1'
    });

    expect(session.getSnapshot().focusedGraphId).toBe('root');
    expect(session.getSnapshot().nodes.filter((node) => node.graphId === 'graph-node-1')).toEqual([]);
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      abstraction: 'terminal',
      expandable: false,
      status: 'pending'
    });
    expect(events.some((event) => event.type === 'nodesAdded' && event.nodes.some((node) => node.graphId === 'graph-node-1'))).toBe(false);
  });

  it('terminalizes AI research child proposals for coding tasks', async () => {
    const events: BridgeEvent[] = [];
    const agent = createAgent({
      planNodes: [planNode({ expandable: true, abstraction: 'decomposable' })],
      planEdges: [],
      decomposeNodes: [
        planNode({ id: 'child-a', title: 'Review Transformer Model Papers', summary: 'Read papers about transformer models.', order: 1 }),
        planNode({ id: 'child-b', title: 'Analyze Transformer Components', summary: 'Analyze model architecture concepts.', order: 2 }),
        planNode({ id: 'child-c', title: 'Evaluate Transformers in Conversational AI', summary: 'Evaluate technologies for conversational AI.', order: 3 })
      ],
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create an AI girlfriend app'
    });
    await session.handleCommand({
      type: 'openNodeGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });
    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'graph-node-1'
    });

    expect(session.getSnapshot().focusedGraphId).toBe('root');
    expect(session.getSnapshot().nodes.filter((node) => node.graphId === 'graph-node-1')).toEqual([]);
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')).toMatchObject({
      abstraction: 'terminal',
      expandable: false,
      status: 'pending'
    });
    expect(events.some((event) => event.type === 'nodesAdded' && event.nodes.some((node) => node.graphId === 'graph-node-1'))).toBe(false);
  });

  it('passes task, depth, ancestors, and siblings into decomposition context', async () => {
    const events: BridgeEvent[] = [];
    let capturedContext = '';
    const agent = createAgent({
      planNodes: [
        planNode({ title: 'Implement chat interface', expandable: true, abstraction: 'decomposable' }),
        planNode({ id: 'node-2', title: 'Validate chat interface tests', kind: 'review', order: 2, expandable: true, abstraction: 'decomposable' })
      ],
      planEdges: [],
      decomposeNodes: [
        planNode({ id: 'child-a', title: 'Inspect chat component files', order: 1, abstraction: 'terminal' }),
        planNode({ id: 'child-b', title: 'Update chat input component', order: 2, abstraction: 'terminal' })
      ],
      decomposeNode: async (_sessionId, _node, context) => {
        capturedContext = context;
        return {
          nodes: [
            planNode({ id: 'child-a', title: 'Inspect chat component files', order: 1, abstraction: 'terminal' }),
            planNode({ id: 'child-b', title: 'Update chat input component', order: 2, abstraction: 'terminal' })
          ],
          edges: []
        };
      },
      execution: completedExecution()
    });
    const session = new AgentSession('session-1', agent, (event) => events.push(event));

    await session.handleCommand({
      type: 'startTask',
      commandId: 'cmd-1',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      task: 'Create an AI girlfriend app'
    });
    await session.handleCommand({
      type: 'openNodeGraph',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      nodeId: 'node-1'
    });
    await session.handleCommand({
      type: 'constructGraph',
      commandId: 'cmd-3',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      graphId: 'graph-node-1',
      instructions: 'Focus on the UI layer.'
    });

    expect(capturedContext).toContain('Original coding task:\nCreate an AI girlfriend app');
    expect(capturedContext).toContain('Current node depth: 0');
    expect(capturedContext).toContain('Ancestor path:\n- Implement chat interface');
    expect(capturedContext).toContain('Sibling nodes already covering nearby work:\n- Validate chat interface tests');
    expect(capturedContext).toContain('User construction instructions:\nFocus on the UI layer.');
  });
});

function createAgent({
  configured = false,
  planNode,
  planNodes,
  planEdges = [],
  decomposeNodes = [],
  decomposeEdges = [],
  decomposeNode,
  executeNode,
  execution
}: {
  configured?: boolean;
  planNode?: MegaplanNode;
  planNodes?: MegaplanNode[];
  planEdges?: MegaplanEdge[];
  decomposeNodes?: MegaplanNode[];
  decomposeEdges?: MegaplanEdge[];
  decomposeNode?: OpenAiAgent['decomposeNode'];
  executeNode?: OpenAiAgent['executeNode'];
  execution: Awaited<ReturnType<OpenAiAgent['executeNode']>>;
}): OpenAiAgent {
  return {
    configured,
    planTask: async () => ({ nodes: planNodes ?? (planNode ? [planNode] : []), edges: planEdges }),
    decomposeNode: decomposeNode ?? (async () => ({ nodes: decomposeNodes, edges: decomposeEdges })),
    executeNode: executeNode ?? (async () => execution)
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
