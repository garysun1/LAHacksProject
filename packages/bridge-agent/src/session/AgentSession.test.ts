import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, MegaplanNode } from '@megaplan/shared';
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
    await flushAsyncWork();

    const approval = events.find((event): event is Extract<BridgeEvent, { type: 'approvalRequested' }> => event.type === 'approvalRequested');
    expect(approval?.toolUse.status).toBe('pending');
    expect(events.some((event) => event.type === 'activeNodeChanged' && event.activeNodeId === undefined)).toBe(true);
    await expect(fs.readFile(path.join(workspaceRoot, 'src/generated.ts'), 'utf8')).rejects.toThrow();

    await session.handleCommand({
      type: 'approveToolUse',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
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
    await flushAsyncWork();

    const approval = events.find((event): event is Extract<BridgeEvent, { type: 'approvalRequested' }> => event.type === 'approvalRequested');
    await session.handleCommand({
      type: 'rejectToolUse',
      commandId: 'cmd-2',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      toolUseId: approval?.toolUse.id ?? '',
      reason: 'Not wanted.'
    });

    expect(events.some((event) => event.type === 'toolUseUpdated' && event.patch.status === 'rejected')).toBe(true);
    expect(session.getSnapshot().pendingToolUses?.[0]?.status).toBe('rejected');
    expect(session.getSnapshot().nodes.find((node) => node.id === 'node-1')?.status).toBe('invalidated');
    await expect(fs.readFile(path.join(workspaceRoot, 'src/rejected.ts'), 'utf8')).rejects.toThrow();
  });
});

function createAgent({ planNode: node, execution }: { planNode: MegaplanNode; execution: Awaited<ReturnType<OpenAiAgent['executeNode']>> }): OpenAiAgent {
  return {
    configured: false,
    planTask: async () => ({ nodes: [node], edges: [] }),
    decomposeNode: async () => ({ nodes: [], edges: [] }),
    executeNode: async () => execution
  } as unknown as OpenAiAgent;
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
