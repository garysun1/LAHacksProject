import { buildSequenceEdges, createEmptySnapshot, getDownstreamNodeIds, reduceBridgeEvent, type BridgeEvent, type DecisionAlternative, type GraphRunStatus, type HumanCommand, type MegaplanGraphScope, type MegaplanGraphSnapshot, type MegaplanNode, type ToolUseRequest } from '@megaplan/shared';
import { OpenAiAgent } from '../openai/OpenAiAgent';
import { fileWriteRequiresApproval } from '../tools/toolPolicy';
import { listWorkspaceFiles, writeWorkspaceFile } from '../tools/workspaceTools';

export type PublishEvent = (event: BridgeEvent) => void;

const ROOT_GRAPH_ID = 'root';

export class AgentSession {
  private snapshot: MegaplanGraphSnapshot;
  private workspaceRoot?: string;
  private readonly runningGraphIds = new Set<string>();
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
      case 'focusGraph':
        this.focusGraph(command.graphId);
        break;
      case 'runGraph':
        await this.runGraph(command.graphId ?? this.snapshot.focusedGraphId ?? this.snapshot.rootGraphId ?? ROOT_GRAPH_ID);
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
      case 'promoteAlternative':
        await this.promoteAlternative(command.nodeId, command.alternativeId);
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
      rootGraphId: ROOT_GRAPH_ID,
      focusedGraphId: ROOT_GRAPH_ID,
      graphs: [this.createGraphScope(ROOT_GRAPH_ID, task, undefined, createdAt)],
      task
    };

    const proposal = await this.agent.planTask(this.sessionId, task);
    const nodes = this.normalizeNodes(proposal.nodes, ROOT_GRAPH_ID);
    this.snapshot = {
      ...this.snapshot,
      nodes,
      edges: buildSequenceEdges(nodes),
      updatedAt: createdAt
    };

    this.emit({
      type: 'sessionSnapshot',
      snapshot: this.snapshot,
      ...this.eventBase()
    });

  }

  private async decomposeNode(nodeId: string): Promise<void> {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot decompose missing node: ${nodeId}`, true);
      return;
    }

    const graphId = node.childGraphId ?? `graph-${node.id}`;
    const now = new Date().toISOString();
    const childGraph = this.snapshot.graphs?.find((graph) => graph.id === graphId) ?? this.createGraphScope(graphId, node.title, node.id, now, node.summary);

    this.emit({ type: 'graphsUpdated', upsert: [childGraph], ...this.eventBase() });
    this.updateNode(nodeId, { childGraphId: graphId, expanded: true });
    this.focusGraph(graphId);
  }

  private async promoteAlternative(nodeId: string, alternativeId: string): Promise<void> {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot promote alternative for missing node: ${nodeId}`, true);
      return;
    }

    const alternative = node.alternatives?.find((candidate) => candidate.id === alternativeId);

    if (!alternative) {
      this.emitAgentError(`Cannot promote missing alternative ${alternativeId} for node ${nodeId}`, true);
      return;
    }

    const graphId = alternative.promotedGraphId ?? `graph-${node.id}-alt-${alternative.id}`;
    const now = new Date().toISOString();
    const childGraph = this.createGraphScope(graphId, alternative.title, node.id, now, alternative.summary);
    const context = `Alternative: ${JSON.stringify(alternative)}\nNode: ${JSON.stringify(node)}`;
    const proposal = await this.agent.decomposeNode(this.sessionId, {
      ...node,
      title: alternative.title,
      summary: alternative.summary
    }, context);
    const nodes = this.normalizeNodes(proposal.nodes, graphId, node.id);
    const alternatives = this.markAlternativePromoted(node.alternatives ?? [], alternativeId, graphId);

    this.emit({ type: 'graphsUpdated', upsert: [childGraph], ...this.eventBase() });
    this.emit({ type: 'nodesAdded', nodes, edges: buildSequenceEdges(nodes), ...this.eventBase() });
    this.updateNode(nodeId, {
      selectedAlternativeId: alternativeId,
      alternatives,
      childGraphId: graphId,
      expanded: true,
      abstraction: 'decomposable'
    });
    this.focusGraph(graphId);
  }

  private focusGraph(graphId: string): void {
    const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

    if (!graph) {
      this.emitAgentError(`Cannot focus missing graph: ${graphId}`, true);
      return;
    }

    this.emit({ type: 'graphFocused', graphId, ...this.eventBase() });
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

  private async runGraph(graphId: string): Promise<void> {
    if (this.runningGraphIds.has(graphId)) {
      return;
    }

    this.runningGraphIds.add(graphId);
    this.emitGraphRunState(graphId, 'running');

    try {
      if (await this.runEmptyGraph(graphId)) {
        return;
      }

      while (true) {
        const nextNode = this.nextRunnableNode(graphId);

        if (!nextNode) {
          break;
        }

        await this.executeNode(nextNode);
      }

      this.emitGraphRunState(graphId, this.graphHasBlockedNodes(graphId) ? 'blocked' : 'completed');
    } finally {
      this.runningGraphIds.delete(graphId);
    }
  }

  private async runEmptyGraph(graphId: string): Promise<boolean> {
    if (this.getGraphNodes(graphId).length > 0) {
      return false;
    }

    const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

    if (!graph?.parentNodeId) {
      this.emitGraphRunState(graphId, 'completed', 'No nodes to run.');
      return true;
    }

    const parentNode = this.snapshot.nodes.find((node) => node.id === graph.parentNodeId);

    if (!parentNode) {
      this.emitAgentError(`Cannot run empty graph without parent node: ${graphId}`, true);
      this.emitGraphRunState(graphId, 'error');
      return true;
    }

    if (this.shouldGenerateSubgraph(parentNode)) {
      await this.populateGraphFromNode(parentNode, graphId);
      this.emitGraphRunState(graphId, 'idle', 'Generated subgraph.');
      return true;
    }

    await this.executeNode(parentNode, { ignoreChildGraph: true });

    const updatedParent = this.snapshot.nodes.find((node) => node.id === parentNode.id);
    this.emitGraphRunState(graphId, updatedParent?.status === 'blocked' ? 'blocked' : 'completed');
    return true;
  }

  private async populateGraphFromNode(node: MegaplanNode, graphId: string): Promise<void> {
    const context = this.snapshot.eventLog?.slice(-20).map((event) => `${event.type}:${event.eventId}`).join('\n') ?? '';
    const proposal = await this.agent.decomposeNode(this.sessionId, node, context);
    const nodes = this.normalizeNodes(proposal.nodes, graphId, node.id);

    this.emit({ type: 'nodesAdded', nodes, edges: buildSequenceEdges(nodes), ...this.eventBase() });
    this.updateNode(node.id, { childGraphId: graphId, expanded: true, abstraction: 'decomposable' });
  }

  private shouldGenerateSubgraph(node: MegaplanNode): boolean {
    return node.expandable === true || node.abstraction === 'abstract' || node.abstraction === 'decomposable';
  }

  private async executeNode(node: MegaplanNode, options: { ignoreChildGraph?: boolean } = {}): Promise<void> {
    this.emit({ type: 'activeNodeChanged', activeNodeId: node.id, ...this.eventBase() });

    if (node.childGraphId && !options.ignoreChildGraph) {
      await this.runGraph(node.childGraphId);

      if (this.graphHasBlockedNodes(node.childGraphId)) {
        this.updateNode(node.id, { status: 'blocked' });
      } else if (this.graphHasPendingNodes(node.childGraphId)) {
        this.updateNode(node.id, { status: 'pending' });
      } else {
        this.updateNode(node.id, { status: 'completed', summary: `Completed subgraph ${node.childGraphId}.` });
      }

      this.emit({ type: 'activeNodeChanged', activeNodeId: undefined, ...this.eventBase() });
      return;
    }

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
        graphId: node.graphId ?? ROOT_GRAPH_ID,
        parentId: node.parentId,
        title: `Approve patch: ${result.proposedPatch.path}`,
        kind: 'approval',
        phase: 'execution',
        status: 'blocked',
        confidence: result.confidence,
        summary: result.proposedPatch.description,
        entailedBy: [node.id]
      };
      this.emit({ type: 'approvalRequested', node: approvalNode, toolUse, edges: [{ id: `${node.id}-${approvalNode.id}`, source: node.id, target: approvalNode.id, kind: 'sequence' }], ...this.eventBase() });
      this.updateNode(node.id, { status: 'blocked', summary: result.summary, rationale: result.rationale, confidence: result.confidence });
      this.emit({ type: 'activeNodeChanged', activeNodeId: undefined, ...this.eventBase() });
      return;
    }

    this.updateNode(node.id, { status: 'completed', summary: result.summary, rationale: result.rationale, confidence: result.confidence });
    this.emit({ type: 'activeNodeChanged', activeNodeId: undefined, ...this.eventBase() });
  }

  private nextRunnableNode(graphId: string): MegaplanNode | undefined {
    const completed = new Set(this.snapshot.nodes.filter((node) => ['completed', 'approved'].includes(node.status)).map((node) => node.id));
    const blockedStatuses = new Set(['active', 'blocked', 'invalidated', 'rejected']);

    return [...this.snapshot.nodes]
      .filter((node) => (node.graphId ?? ROOT_GRAPH_ID) === graphId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .find((node) => {
        if (node.kind === 'approval' || node.status !== 'pending' || blockedStatuses.has(node.status)) {
          return false;
        }

        const graphNodeIds = new Set(this.snapshot.nodes.filter((candidate) => (candidate.graphId ?? ROOT_GRAPH_ID) === graphId).map((candidate) => candidate.id));
        const dependencies = this.snapshot.edges.filter((edge) => graphNodeIds.has(edge.source) && edge.target === node.id);
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
        this.updateEntailedApprovalNodes(toolUse.nodeId, 'approved');
        const node = this.snapshot.nodes.find((candidate) => candidate.id === toolUse.nodeId);
        void this.runGraph(node?.graphId ?? this.snapshot.focusedGraphId ?? this.snapshot.rootGraphId ?? ROOT_GRAPH_ID);
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

  private updateEntailedApprovalNodes(nodeId: string, status: MegaplanNode['status']): void {
    const patches = this.snapshot.nodes
      .filter((node) => node.kind === 'approval' && node.entailedBy?.includes(nodeId))
      .map((node) => ({ id: node.id, patch: { status } }));

    if (patches.length > 0) {
      this.emit({ type: 'nodesUpdated', patches, ...this.eventBase() });
    }
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

  private createGraphScope(id: string, title: string, parentNodeId?: string, timestamp = new Date().toISOString(), summary?: string): MegaplanGraphScope {
    return {
      id,
      title,
      parentNodeId,
      status: 'idle',
      summary,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private normalizeNodes(nodes: MegaplanNode[], graphId: string, fallbackParentId?: string): MegaplanNode[] {
    return nodes.map((node) => ({
      ...node,
      graphId,
      parentId: node.parentId ?? fallbackParentId,
      abstraction: node.abstraction ?? (node.expandable ? 'decomposable' : 'runnable')
    }));
  }

  private markAlternativePromoted(alternatives: DecisionAlternative[], alternativeId: string, promotedGraphId: string): DecisionAlternative[] {
    return alternatives.map((alternative) => ({
      ...alternative,
      status: alternative.id === alternativeId ? 'selected' : alternative.status === 'selected' ? 'candidate' : alternative.status,
      promotedGraphId: alternative.id === alternativeId ? promotedGraphId : alternative.promotedGraphId
    }));
  }

  private graphHasBlockedNodes(graphId: string): boolean {
    return this.snapshot.nodes.some((node) => (node.graphId ?? ROOT_GRAPH_ID) === graphId && ['blocked', 'invalidated', 'rejected'].includes(node.status));
  }

  private graphHasPendingNodes(graphId: string): boolean {
    return this.snapshot.nodes.some((node) => (node.graphId ?? ROOT_GRAPH_ID) === graphId && node.status === 'pending');
  }

  private getGraphNodes(graphId: string): MegaplanNode[] {
    return this.snapshot.nodes.filter((node) => (node.graphId ?? ROOT_GRAPH_ID) === graphId);
  }

  private emitGraphRunState(graphId: string, status: GraphRunStatus, message?: string): void {
    this.emit({ type: 'graphRunStateChanged', graphId, status, message, ...this.eventBase() });
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
