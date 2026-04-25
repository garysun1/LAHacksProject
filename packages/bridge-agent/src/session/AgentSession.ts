import { createEmptySnapshot, getDownstreamNodeIds, reduceBridgeEvent, type BridgeEvent, type HumanCommand, type MegaplanGraphSnapshot, type MegaplanNode, type ToolUseRequest } from '@megaplan/shared';
import { OpenAiAgent } from '../openai/OpenAiAgent';
import { fileWriteRequiresApproval } from '../tools/toolPolicy';
import { listWorkspaceFiles, writeWorkspaceFile } from '../tools/workspaceTools';

export type PublishEvent = (event: BridgeEvent) => void;

export class AgentSession {
  private snapshot: MegaplanGraphSnapshot;
  private workspaceRoot?: string;
  private running = false;
  private readonly approvedToolUses = new Set<string>();
  private readonly rejectedToolUses = new Set<string>();

  constructor(
    readonly sessionId: string,
    private readonly agent: OpenAiAgent,
    private readonly publish: PublishEvent
  ) {
    this.snapshot = createEmptySnapshot(sessionId);
  }

  getSnapshot(): MegaplanGraphSnapshot {
    return this.snapshot;
  }

  async handleCommand(command: HumanCommand): Promise<void> {
    switch (command.type) {
      case 'startTask':
        await this.startTask(command.task, command.workspaceRoot);
        break;
      case 'decomposeNode':
        await this.decomposeNode(command.nodeId);
        break;
      case 'reorderNodes':
        this.reorderNodes(command.orderedNodeIds, command.parentId);
        break;
      case 'deleteNode':
        this.updateNode(command.nodeId, { status: 'rejected' });
        this.invalidateDownstream(command.nodeId, 'Deleted by user.');
        break;
      case 'pinNode':
        this.updateNode(command.nodeId, { pinned: command.pinned });
        break;
      case 'selectAlternative':
        this.updateNode(command.nodeId, { selectedAlternativeId: command.alternativeId });
        break;
      case 'approveNode':
        this.updateNode(command.nodeId, { status: 'approved' });
        break;
      case 'rejectNode':
        this.updateNode(command.nodeId, { status: 'rejected' });
        this.invalidateDownstream(command.nodeId, command.reason ?? 'Rejected by user.');
        break;
      case 'approveToolUse':
        await this.approveToolUse(command.toolUseId);
        break;
      case 'rejectToolUse':
        this.rejectedToolUses.add(command.toolUseId);
        this.rejectToolUse(command.toolUseId, command.reason);
        break;
      case 'requestReplan':
        this.emitAgentError('Replan is queued for a later prototype slice.', true, command.reason);
        break;
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  private async startTask(task: string, workspaceRoot?: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    const createdAt = new Date().toISOString();
    this.snapshot = {
      ...createEmptySnapshot(this.sessionId),
      createdAt,
      updatedAt: createdAt,
      task
    };

    const proposal = await this.agent.planTask(this.sessionId, task);
    this.snapshot = {
      ...this.snapshot,
      nodes: proposal.nodes,
      edges: proposal.edges,
      updatedAt: createdAt
    };

    this.emit({
      type: 'sessionSnapshot',
      snapshot: this.snapshot,
      ...this.eventBase()
    });

    void this.runExecutionLoop();
  }

  private async decomposeNode(nodeId: string): Promise<void> {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot decompose missing node: ${nodeId}`, true);
      return;
    }

    const context = this.snapshot.eventLog?.slice(-20).map((event) => `${event.type}:${event.eventId}`).join('\n') ?? '';
    const proposal = await this.agent.decomposeNode(this.sessionId, node, context);

    this.emit({
      type: 'nodesAdded',
      nodes: proposal.nodes,
      edges: proposal.edges,
      ...this.eventBase()
    });
    this.updateNode(nodeId, { expanded: true });
  }

  private reorderNodes(orderedNodeIds: string[], parentId?: string): void {
    const orderById = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index + 1]));
    const patches = this.snapshot.nodes
      .filter((node) => node.parentId === parentId && orderById.has(node.id))
      .map((node) => ({ id: node.id, patch: { order: orderById.get(node.id) } }));

    if (patches.length > 0) {
      this.emit({ type: 'nodesUpdated', patches, ...this.eventBase() });
    }
  }

  private async runExecutionLoop(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      while (true) {
        const nextNode = this.nextRunnableNode();

        if (!nextNode) {
          break;
        }

        await this.executeNode(nextNode);
      }
    } finally {
      this.running = false;
    }
  }

  private async executeNode(node: MegaplanNode): Promise<void> {
    this.emit({ type: 'activeNodeChanged', activeNodeId: node.id, ...this.eventBase() });

    const workspaceSummary = this.workspaceRoot ? await summarizeWorkspace(this.workspaceRoot) : 'No workspace root provided.';
    const result = await this.agent.executeNode(node, workspaceSummary);

    for (const observation of result.observations) {
      this.emit({
        type: 'artifactLinked',
        nodeId: node.id,
        artifact: {
          id: randomId('artifact'),
          kind: 'observation',
          title: 'Observation',
          content: observation
        },
        ...this.eventBase()
      });
    }

    if (result.alternatives?.length) {
      this.emit({ type: 'alternativesProposed', nodeId: node.id, alternatives: result.alternatives, ...this.eventBase() });
    }

    if (result.proposedPatch && this.workspaceRoot) {
      const toolUse = this.createPatchToolUse(node.id, result.proposedPatch.path, result.proposedPatch.content, result.proposedPatch.description);
      const approvalNode: MegaplanNode = {
        id: `${node.id}-approval-${toolUse.id}`,
        parentId: node.parentId,
        title: `Approve patch: ${result.proposedPatch.path}`,
        kind: 'approval',
        phase: 'execution',
        status: 'blocked',
        confidence: result.confidence,
        summary: result.proposedPatch.description,
        entailedBy: [node.id]
      };
      this.emit({ type: 'approvalRequested', node: approvalNode, toolUse, edges: [{ id: `${node.id}-${approvalNode.id}`, source: node.id, target: approvalNode.id, kind: 'entailment' }], ...this.eventBase() });
      this.updateNode(node.id, { status: 'blocked', summary: result.summary, rationale: result.rationale, confidence: result.confidence });
      this.emit({ type: 'activeNodeChanged', activeNodeId: undefined, ...this.eventBase() });
      return;
    }

    this.updateNode(node.id, { status: 'completed', summary: result.summary, rationale: result.rationale, confidence: result.confidence });
    this.emit({ type: 'activeNodeChanged', activeNodeId: undefined, ...this.eventBase() });
  }

  private nextRunnableNode(): MegaplanNode | undefined {
    const completed = new Set(this.snapshot.nodes.filter((node) => ['completed', 'approved'].includes(node.status)).map((node) => node.id));
    const blockedStatuses = new Set(['active', 'blocked', 'invalidated', 'rejected']);

    return [...this.snapshot.nodes]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .find((node) => {
        if (node.kind === 'approval' || node.parentId || node.status !== 'pending' || blockedStatuses.has(node.status)) {
          return false;
        }

        const dependencies = this.snapshot.edges.filter((edge) => edge.target === node.id && (edge.kind === 'dependency' || edge.kind === 'sequence'));
        return dependencies.every((edge) => completed.has(edge.source));
      });
  }

  private async approveToolUse(toolUseId: string): Promise<void> {
    const toolUse = this.snapshot.pendingToolUses?.find((candidate) => candidate.id === toolUseId);

    if (!toolUse) {
      this.emitAgentError(`Cannot approve missing tool use: ${toolUseId}`, true);
      return;
    }

    if (!this.workspaceRoot) {
      this.updateToolUse(toolUseId, 'failed');
      this.emitAgentError(`Cannot approve tool use without a workspace root: ${toolUseId}`, true);
      return;
    }

    this.approvedToolUses.add(toolUseId);
    this.updateToolUse(toolUseId, 'approved');

    if (toolUse.kind === 'patch' && toolUse.path && typeof toolUse.proposedContent === 'string') {
      try {
        await writeWorkspaceFile(this.workspaceRoot, toolUse.path, toolUse.proposedContent);
        this.updateToolUse(toolUseId, 'applied');
        this.emit({
          type: 'artifactLinked',
          nodeId: toolUse.nodeId,
          artifact: {
            id: randomId('artifact'),
            kind: 'patch',
            title: `Applied patch to ${toolUse.path}`,
            path: toolUse.path,
            content: toolUse.proposedContent
          },
          ...this.eventBase()
        });
        this.updateNode(toolUse.nodeId, { status: 'completed' });
        void this.runExecutionLoop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateToolUse(toolUseId, 'failed');
        this.emitAgentError(`Failed to apply approved tool use ${toolUseId}: ${message}`, true);
      }
      return;
    }

    this.updateToolUse(toolUseId, 'failed');
    this.emitAgentError(`Unsupported tool use approval: ${toolUseId}`, true, toolUse);
  }

  private rejectToolUse(toolUseId: string, reason?: string): void {
    const toolUse = this.snapshot.pendingToolUses?.find((candidate) => candidate.id === toolUseId);
    this.updateToolUse(toolUseId, 'rejected');

    if (toolUse) {
      this.updateNode(toolUse.nodeId, { status: 'rejected' });
      this.invalidateDownstream(toolUse.nodeId, reason ?? 'Tool use rejected by user.');
    }
  }

  private updateToolUse(toolUseId: string, status: ToolUseRequest['status']): void {
    this.emit({ type: 'toolUseUpdated', toolUseId, patch: { status }, ...this.eventBase() });
  }

  private updateNode(nodeId: string, patch: Partial<MegaplanNode>): void {
    this.emit({ type: 'nodesUpdated', patches: [{ id: nodeId, patch }], ...this.eventBase() });
  }

  private invalidateDownstream(nodeId: string, reason: string): void {
    const impactedNodeIds = getDownstreamNodeIds(nodeId, this.snapshot.edges);
    this.emit({ type: 'nodeInvalidated', nodeId, reason, impactedNodeIds, ...this.eventBase() });
  }

  private createPatchToolUse(nodeId: string, filePath: string, content: string, description: string): ToolUseRequest {
    const decision = fileWriteRequiresApproval();
    return {
      id: randomId('tool'),
      kind: 'patch',
      nodeId,
      title: `Write ${filePath}`,
      description: decision.reason ? `${description}\n\n${decision.reason}` : description,
      path: filePath,
      proposedContent: content,
      status: 'pending'
    };
  }

  private emit(event: BridgeEvent): void {
    this.snapshot = reduceBridgeEvent(this.snapshot, event);
    this.publish(event);
  }

  private emitAgentError(message: string, recoverable = true, details?: unknown): void {
    this.emit({ type: 'agentError', message, recoverable, details, ...this.eventBase() });
  }

  private eventBase(): { eventId: string; sessionId: string; timestamp: string } {
    return {
      eventId: randomId('evt'),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString()
    };
  }
}

async function summarizeWorkspace(workspaceRoot: string): Promise<string> {
  const files = await listWorkspaceFiles(workspaceRoot, '.', 80);
  return `Workspace files:\n${files.join('\n')}`;
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
