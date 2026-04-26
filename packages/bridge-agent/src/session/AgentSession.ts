import { buildSequenceEdges, createEmptySnapshot, getDownstreamNodeIds, reduceBridgeEvent, type BridgeEvent, type DecisionAlternative, type GraphRunStatus, type HumanCommand, type MegaplanGraphScope, type MegaplanGraphSnapshot, type MegaplanNode, type ToolUseRequest } from '@megaplan/shared';
import { OpenAiAgent } from '../openai/OpenAiAgent';
import { fileWriteRequiresApproval } from '../tools/toolPolicy';
import { listWorkspaceFiles, writeWorkspaceFile } from '../tools/workspaceTools';

export type PublishEvent = (event: BridgeEvent) => void;

const ROOT_GRAPH_ID = 'root';
const CODING_TERMS = ['add', 'api', 'auth', 'backend', 'bridge', 'build', 'command', 'compile', 'component', 'config', 'create', 'css', 'database', 'debug', 'dependency', 'edit', 'endpoint', 'extension', 'file', 'fix', 'frontend', 'hook', 'implement', 'inspect', 'interface', 'javascript', 'locate', 'node', 'npm', 'package', 'patch', 'prompt', 'react', 'read', 'reducer', 'refactor', 'render', 'route', 'run', 'schema', 'service', 'session', 'state', 'style', 'test', 'tsx', 'type', 'typecheck', 'typescript', 'ui', 'update', 'validate', 'vite', 'webview', 'wire', 'workspace', 'write'];
const GENERIC_PLANNING_TERMS = ['analyze', 'assess', 'categorize', 'clarify', 'conduct', 'define', 'determine', 'engage', 'establish', 'explore', 'gather', 'identify', 'outline', 'plan', 'research', 'review', 'understand'];
const NON_CODING_TERMS = ['business plan', 'competitor', 'customer discovery', 'go-to-market', 'interview', 'market research', 'marketing', 'persona', 'pricing', 'project boundary', 'project goal', 'project scope', 'revenue', 'sales', 'stakeholder', 'survey'];
const RESEARCH_SCOPE_TERMS = ['ai model survey', 'architecture research', 'best practices', 'compare frameworks', 'compare technologies', 'conceptual analysis', 'current ai technologies', 'evaluate technologies', 'evaluate transformers', 'literature review', 'model architecture', 'model architectures', 'paper', 'papers', 'read papers', 'research', 'review papers', 'survey models', 'technology comparison', 'transformer architecture', 'transformer architectures', 'transformer component', 'transformer components', 'transformer model', 'transformer papers'];
const IMPLEMENTATION_ANCHOR_TERMS = ['api', 'app', 'code', 'component', 'endpoint', 'file', 'implement', 'integration', 'route', 'schema', 'service', 'test', 'ui', 'wire'];
const EXPLICIT_NON_CODING_TERMS = ['business plan', 'customer discovery', 'go-to-market', 'interview stakeholders', 'market research', 'marketing plan', 'sales strategy', 'stakeholder analysis', 'user research'];
const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'for', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with']);

type DecompositionContextInfo = {
  nodeDepth: number;
  ancestors: MegaplanNode[];
  siblings: MegaplanNode[];
};

export class AgentSession {
  private snapshot: MegaplanGraphSnapshot;
  private workspaceRoot?: string;
  private readonly runningGraphIds = new Set<string>();
  private readonly graphRunContextIds = new Set<string>();
  private readonly pendingGraphResumeIds = new Set<string>();
  private readonly graphRunApprovalToolUses = new Map<string, string>();
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
        await this.constructRootGraph(command.task, command.workspaceRoot);
        break;
      case 'hydrateSession':
        this.hydrateSession(command.snapshot, command.workspaceRoot);
        break;
      case 'decomposeNode':
        this.openNodeGraph(command.nodeId);
        break;
      case 'openNodeGraph':
        this.openNodeGraph(command.nodeId);
        break;
      case 'constructGraph':
        await this.constructGraph(command.graphId ?? this.snapshot.focusedGraphId ?? this.snapshot.rootGraphId ?? ROOT_GRAPH_ID, command.instructions, command.workspaceRoot);
        break;
      case 'clearGraph':
        this.clearGraph(command.graphId ?? this.snapshot.focusedGraphId ?? this.snapshot.rootGraphId ?? ROOT_GRAPH_ID);
        break;
      case 'focusGraph':
        this.focusGraph(command.graphId);
        break;
      case 'runGraph':
        await this.runGraph(command.graphId ?? this.snapshot.focusedGraphId ?? this.snapshot.rootGraphId ?? ROOT_GRAPH_ID);
        break;
      case 'runNode':
        await this.runNode(command.nodeId);
        break;
      case 'reorderNodes':
        this.reorderNodes(command.orderedNodeIds, command.parentId);
        break;
      case 'deleteNode':
        this.deleteNode(command.nodeId);
        break;
      case 'updateNodeDetails':
        this.updateNodeDetails(command.nodeId, { title: command.title, summary: command.summary, rationale: command.rationale });
        break;
      case 'pinNode':
        this.updateNode(command.nodeId, { pinned: command.pinned });
        break;
      case 'selectAlternative':
        this.selectAlternative(command.nodeId, command.alternativeId);
        break;
      case 'approveNode':
        this.updateNode(command.nodeId, { status: 'approved' });
        break;
      case 'rejectNode':
        this.rejectNodeAndFollowing(command.nodeId);
        break;
      case 'approveToolUse':
        await this.approveToolUse(command.toolUseId);
        break;
      case 'rejectToolUse':
        this.rejectedToolUses.add(command.toolUseId);
        this.rejectToolUse(command.toolUseId);
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

  private async constructRootGraph(task: string, workspaceRoot?: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    const trimmedTask = task.trim();

    if (!trimmedTask) {
      this.emitAgentError('Cannot construct the root graph without instructions.', true);
      return;
    }

    const createdAt = new Date().toISOString();
    this.snapshot = {
      ...createEmptySnapshot(this.sessionId),
      createdAt,
      updatedAt: createdAt,
      rootGraphId: ROOT_GRAPH_ID,
      focusedGraphId: ROOT_GRAPH_ID,
      graphs: [this.createGraphScope(ROOT_GRAPH_ID, trimmedTask, undefined, createdAt)],
      task: trimmedTask
    };

    const proposal = await this.agent.planTask(this.sessionId, trimmedTask);
    const proposedNodes = this.normalizeNodes(proposal.nodes, ROOT_GRAPH_ID);
    const nodes = this.agent.configured ? this.vetRootGraphNodes(proposedNodes, trimmedTask) : proposedNodes;
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

  private hydrateSession(snapshot: MegaplanGraphSnapshot, workspaceRoot?: string): void {
    this.snapshot = {
      ...snapshot,
      sessionId: this.sessionId
    };

    if (workspaceRoot) {
      this.workspaceRoot = workspaceRoot;
    }
  }

  private openNodeGraph(nodeId: string): string | undefined {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot open missing node: ${nodeId}`, true);
      return;
    }

    if (this.isTerminalNode(node)) {
      this.emitGraphRunState(node.graphId ?? ROOT_GRAPH_ID, 'idle', 'Terminal node.');
      return;
    }

    const graphId = node.childGraphId ?? `graph-${node.id}`;
    const now = new Date().toISOString();
    const childGraph = this.snapshot.graphs?.find((graph) => graph.id === graphId) ?? this.createGraphScope(graphId, node.title, node.id, now, node.summary);

    this.emit({ type: 'graphsUpdated', upsert: [childGraph], ...this.eventBase() });
    this.updateNode(nodeId, { childGraphId: graphId, expanded: true });
    this.focusGraph(graphId);
    return graphId;
  }

  private async constructGraph(graphId: string, instructions?: string, workspaceRoot?: string): Promise<void> {
    if (workspaceRoot) {
      this.workspaceRoot = workspaceRoot;
    }

    const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

    if (!graph) {
      this.emitAgentError(`Cannot construct missing graph: ${graphId}`, true);
      return;
    }

    if (this.getGraphNodes(graphId).length > 0) {
      this.emitAgentError(`Cannot construct non-empty graph: ${graph.title}`, true);
      this.emitGraphRunState(graphId, 'idle', 'Graph already has nodes.');
      return;
    }

    const trimmedInstructions = instructions?.trim() ?? '';

    if (!graph.parentNodeId) {
      await this.constructRootGraph(trimmedInstructions, workspaceRoot);
      return;
    }

    const parentNode = this.snapshot.nodes.find((node) => node.id === graph.parentNodeId);

    if (!parentNode) {
      this.emitAgentError(`Cannot construct graph without parent node: ${graphId}`, true);
      return;
    }

    this.emitGraphRunState(graphId, 'running', 'Constructing subgraph.');
    const constructed = await this.populateGraphFromNode(parentNode, graphId, trimmedInstructions);

    if (!constructed) {
      this.updateNode(parentNode.id, { abstraction: 'terminal', expandable: false, expanded: false, status: 'pending', summary: 'Unambiguous terminal step; no child graph needed.' });
      this.emitGraphRunState(graphId, 'idle', 'No child steps needed.');
      this.focusParentGraph(parentNode);
      return;
    }

    this.emitGraphRunState(graphId, 'idle', 'Constructed subgraph.');
  }

  private selectAlternative(nodeId: string, alternativeId: string): void {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot select alternative for missing node: ${nodeId}`, true);
      return;
    }

    const alternative = node.alternatives?.find((candidate) => candidate.id === alternativeId);

    if (!alternative) {
      this.emitAgentError(`Cannot select missing alternative ${alternativeId} for node ${nodeId}`, true);
      return;
    }

    const alternatives: DecisionAlternative[] = (node.alternatives ?? []).map((candidate) => ({
      ...candidate,
      status: candidate.id === alternativeId ? 'selected' as const : candidate.status === 'selected' ? 'candidate' as const : candidate.status
    }));
    const rationale = alternative.tradeoffs.length > 0 ? `Selected alternative tradeoffs: ${alternative.tradeoffs.join(' · ')}` : node.rationale;

    this.updateNode(nodeId, {
      title: alternative.title,
      summary: alternative.summary,
      rationale,
      selectedAlternativeId: alternativeId,
      alternatives
    });
  }

  private focusGraph(graphId: string): void {
    const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

    if (!graph) {
      this.emitAgentError(`Cannot focus missing graph: ${graphId}`, true);
      return;
    }

    this.emit({ type: 'graphFocused', graphId, ...this.eventBase() });
  }

  private focusParentGraph(node: MegaplanNode): void {
    const parentGraphId = node.graphId ?? ROOT_GRAPH_ID;

    if (this.snapshot.graphs?.some((graph) => graph.id === parentGraphId)) {
      this.focusGraph(parentGraphId);
    }
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
    this.graphRunContextIds.add(graphId);
    this.emitGraphRunState(graphId, 'running');

    try {
      if (await this.runEmptyGraph(graphId)) {
        return;
      }

      await this.runGraphNodesInOrder(graphId);

      const status = this.graphHasBlockedNodes(graphId) || this.graphHasRejectedNodes(graphId) ? 'blocked' : this.graphHasPendingNodes(graphId) ? 'idle' : 'completed';
      this.emitGraphRunState(graphId, status);
      this.updateParentAfterGraphRun(graphId, status);

      if (status !== 'blocked') {
        this.emit({ type: 'activeNodeChanged', activeNodeId: undefined, ...this.eventBase() });
      }
    } finally {
      this.graphRunContextIds.delete(graphId);
      this.runningGraphIds.delete(graphId);

      if (this.pendingGraphResumeIds.delete(graphId)) {
        await this.runGraph(graphId);
      }
    }
  }

  private async runEmptyGraph(graphId: string): Promise<boolean> {
    if (this.getGraphNodes(graphId).length > 0) {
      return false;
    }

    const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

    if (!graph?.parentNodeId) {
      this.emitGraphRunState(graphId, 'idle', 'No nodes to run.');
      return true;
    }

    this.emitGraphRunState(graphId, 'idle', 'No nodes to run. Construct this graph first.');
    return true;
  }

  private async runNode(nodeId: string): Promise<void> {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot run missing node: ${nodeId}`, true);
      return;
    }

    if (this.isTerminalNode(node)) {
      const graphId = node.graphId ?? ROOT_GRAPH_ID;
      this.emitGraphRunState(graphId, 'running', `Running ${node.title}.`);
      await this.runNodeSubtree(node.id);

      const updatedNode = this.snapshot.nodes.find((candidate) => candidate.id === node.id);
      this.emitGraphRunState(graphId, updatedNode && this.isBlockedStatus(updatedNode.status) ? 'blocked' : 'completed');
      return;
    }

    const graphId = this.openNodeGraph(nodeId);

    if (!graphId) {
      return;
    }

    if (this.getGraphNodes(graphId).length > 0) {
      await this.runNodeSubtree(node.id);

      if (this.graphHasBlockedNodes(graphId)) {
        return;
      }

      this.focusParentGraph(node);
      this.emit({ type: 'activeNodeChanged', activeNodeId: node.id, ...this.eventBase() });
      return;
    }

    if (this.shouldConstructBeforeRunning(node)) {
      this.emitGraphRunState(graphId, 'idle', 'Construct this graph before running this node.');
      return;
    }

    this.emitGraphRunState(graphId, 'running', `Running ${node.title}.`);
    await this.runNodeSubtree(node.id);

    const updatedNode = this.snapshot.nodes.find((candidate) => candidate.id === node.id);
    this.emitGraphRunState(graphId, updatedNode && this.isBlockedStatus(updatedNode.status) ? 'blocked' : 'completed');
  }

  private async runNodeSubtree(nodeId: string): Promise<void> {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot run missing node: ${nodeId}`, true);
      return;
    }

    this.emit({ type: 'activeNodeChanged', activeNodeId: node.id, ...this.eventBase() });

    if (this.isBlockedStatus(node.status)) {
      return;
    }

    if (node.childGraphId && this.getGraphNodes(node.childGraphId).length > 0) {
      this.focusGraph(node.childGraphId);
      await this.runGraphSubtree(node.childGraphId);
      const updatedNode = this.snapshot.nodes.find((candidate) => candidate.id === node.id);

      if (updatedNode) {
        this.updateParentNodeFromChildGraph(updatedNode, node.childGraphId);
      }

      if (!this.graphHasBlockedNodes(node.childGraphId)) {
        this.focusParentGraph(node);
        this.emit({ type: 'activeNodeChanged', activeNodeId: node.id, ...this.eventBase() });
      }

      return;
    }

    if (['completed', 'approved'].includes(node.status)) {
      return;
    }

    if (node.status === 'pending') {
      await this.executeNode(node, { ignoreChildGraph: true });
    }
  }

  private async runGraphSubtree(graphId: string): Promise<void> {
    if (this.runningGraphIds.has(graphId)) {
      return;
    }

    this.runningGraphIds.add(graphId);
    this.emitGraphRunState(graphId, 'running');

    try {
      const nodes = this.getGraphNodes(graphId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      if (nodes.length === 0) {
        this.emitGraphRunState(graphId, 'completed', 'No child steps needed.');
        return;
      }

      await this.runGraphNodesInOrder(graphId);

      this.emitGraphRunState(graphId, this.graphHasBlockedNodes(graphId) || this.graphHasRejectedNodes(graphId) ? 'blocked' : this.graphHasPendingNodes(graphId) ? 'idle' : 'completed');
    } finally {
      this.runningGraphIds.delete(graphId);
    }
  }

  private async runGraphNodesInOrder(graphId: string): Promise<void> {
    const nodes = this.getGraphNodes(graphId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const node of nodes) {
      const currentNode = this.snapshot.nodes.find((candidate) => candidate.id === node.id);

      if (!currentNode) {
        continue;
      }

      if (this.isBlockedStatus(currentNode.status)) {
        this.emit({ type: 'activeNodeChanged', activeNodeId: currentNode.id, ...this.eventBase() });
        break;
      }

      if (['completed', 'approved'].includes(currentNode.status)) {
        await this.runNodeSubtree(currentNode.id);
      } else if (currentNode.status === 'pending' && this.nodeDependenciesCompleted(currentNode, graphId)) {
        await this.runNodeSubtree(currentNode.id);
      }

      if (this.graphHasBlockedNodes(graphId) || this.graphHasRejectedNodes(graphId)) {
        break;
      }
    }
  }

  private updateParentNodeFromChildGraph(node: MegaplanNode, graphId: string): void {
    if (this.graphHasRejectedNodes(graphId)) {
      this.updateNode(node.id, { status: 'rejected' });
      return;
    }

    if (this.graphHasBlockedNodes(graphId)) {
      this.updateNode(node.id, { status: 'blocked' });
      return;
    }

    if (this.graphHasPendingNodes(graphId)) {
      this.updateNode(node.id, { status: 'pending' });
      return;
    }

    this.updateNode(node.id, { status: 'completed', summary: `Completed subgraph ${graphId}.` });
  }

  private updateParentAfterGraphRun(graphId: string, status: GraphRunStatus): void {
    const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

    if (!graph?.parentNodeId || status === 'blocked') {
      return;
    }

    const parentNode = this.snapshot.nodes.find((candidate) => candidate.id === graph.parentNodeId);

    if (!parentNode) {
      return;
    }

    this.updateParentNodeFromChildGraph(parentNode, graphId);

    if (status === 'completed') {
      this.focusParentGraph(parentNode);
      this.emit({ type: 'activeNodeChanged', activeNodeId: parentNode.id, ...this.eventBase() });
    }
  }

  private async populateGraphFromNode(node: MegaplanNode, graphId: string, instructions?: string): Promise<boolean> {
    const { context, info } = this.buildDecompositionContext(node, instructions);
    const proposal = await this.agent.decomposeNode(this.sessionId, node, context);
    const proposedNodes = this.normalizeNodes(proposal.nodes, graphId, node.id);
    const nodes = this.vetDecompositionNodes(node, proposedNodes, info);

    if (nodes.length === 0) {
      return false;
    }

    this.emit({ type: 'nodesAdded', nodes, edges: buildSequenceEdges(nodes), ...this.eventBase() });
    this.updateNode(node.id, { childGraphId: graphId, expanded: true, abstraction: 'decomposable', status: 'pending' });
    return true;
  }

  private shouldConstructBeforeRunning(node: MegaplanNode): boolean {
    return node.expandable === true || node.abstraction === 'abstract' || node.abstraction === 'decomposable';
  }

  private async executeNode(node: MegaplanNode, options: { ignoreChildGraph?: boolean } = {}): Promise<void> {
    this.emit({ type: 'activeNodeChanged', activeNodeId: node.id, ...this.eventBase() });

    if (node.childGraphId && !options.ignoreChildGraph) {
      if (this.getGraphNodes(node.childGraphId).length === 0) {
        await this.executeNode(node, { ignoreChildGraph: true });
        return;
      }

      await this.runGraph(node.childGraphId);

      if (this.graphHasRejectedNodes(node.childGraphId)) {
        this.updateNode(node.id, { status: 'rejected' });
        return;
      } else if (this.graphHasBlockedNodes(node.childGraphId)) {
        this.updateNode(node.id, { status: 'blocked' });
        return;
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
      const resumeGraphId = this.getActiveGraphRunForNode(node);

      if (resumeGraphId) {
        this.graphRunApprovalToolUses.set(toolUse.id, resumeGraphId);
      }

      this.emit({ type: 'approvalRequested', toolUse, ...this.eventBase() });
      this.updateNode(node.id, { status: 'blocked', summary: `Approval required: ${toolUse.title}`, rationale: result.rationale, confidence: result.confidence });
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

  private getActiveGraphRunForNode(node: MegaplanNode): string | undefined {
    let graphId = node.graphId ?? ROOT_GRAPH_ID;

    while (true) {
      if (this.graphRunContextIds.has(graphId)) {
        return graphId;
      }

      const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

      if (!graph?.parentNodeId) {
        return undefined;
      }

      const parentNode = this.snapshot.nodes.find((candidate) => candidate.id === graph.parentNodeId);

      if (!parentNode) {
        return undefined;
      }

      graphId = parentNode.graphId ?? ROOT_GRAPH_ID;
    }
  }

  private async approveToolUse(toolUseId: string): Promise<void> {
    const toolUse = this.snapshot.pendingToolUses?.find((candidate) => candidate.id === toolUseId);

    if (!toolUse) {
      this.emitAgentError(`Cannot approve missing tool use: ${toolUseId}`, true);
      return;
    }

    if (toolUse.status !== 'pending') {
      this.emitAgentError(`Cannot approve tool use ${toolUseId} with status ${toolUse.status}.`, true);
      return;
    }

    if (!this.workspaceRoot) {
      this.updateToolUse(toolUseId, 'failed');
      this.emitAgentError(`Cannot approve tool use without a workspace root: ${toolUseId}`, true);
      return;
    }

    this.approvedToolUses.add(toolUseId);
    this.updateToolUse(toolUseId, 'approved');
    const resumeGraphId = this.graphRunApprovalToolUses.get(toolUseId);
    this.graphRunApprovalToolUses.delete(toolUseId);

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
        const node = this.snapshot.nodes.find((candidate) => candidate.id === toolUse.nodeId);

        if (node) {
          this.refreshAncestorStatusesFrom(node);
        }

        if (resumeGraphId) {
          await this.resumeGraphRun(resumeGraphId);
        } else {
          this.emit({ type: 'activeNodeChanged', activeNodeId: undefined, ...this.eventBase() });
        }
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

  private rejectToolUse(toolUseId: string): void {
    const toolUse = this.snapshot.pendingToolUses?.find((candidate) => candidate.id === toolUseId);
    this.graphRunApprovalToolUses.delete(toolUseId);
    this.updateToolUse(toolUseId, 'rejected');

    if (toolUse) {
      this.rejectNodeAndFollowing(toolUse.nodeId);
    }
  }

  private async resumeGraphRun(graphId: string): Promise<void> {
    if (this.runningGraphIds.has(graphId)) {
      this.pendingGraphResumeIds.add(graphId);
      return;
    }

    await this.runGraph(graphId);
  }

  private updateToolUse(toolUseId: string, status: ToolUseRequest['status']): void {
    this.emit({ type: 'toolUseUpdated', toolUseId, patch: { status }, ...this.eventBase() });
  }

  private updateNode(nodeId: string, patch: Partial<MegaplanNode>): void {
    this.emit({ type: 'nodesUpdated', patches: [{ id: nodeId, patch }], ...this.eventBase() });
  }

  private rejectNodeAndFollowing(nodeId: string): void {
    const rejectedNodeIds = this.getRejectedPropagationNodeIds(nodeId);
    const patches = rejectedNodeIds.map((id) => ({ id, patch: { status: 'rejected' as const } }));

    if (patches.length > 0) {
      this.emit({ type: 'nodesUpdated', patches, ...this.eventBase() });
    }
  }

  private getRejectedPropagationNodeIds(nodeId: string): string[] {
    const rejectedNodeIds = new Set<string>();
    const addNodeAndSubgraph = (id: string): void => {
      rejectedNodeIds.add(id);

      for (const subgraphNodeId of this.getRecursiveSubgraphNodeIds(id)) {
        rejectedNodeIds.add(subgraphNodeId);
      }
    };
    let currentNode = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    while (currentNode) {
      addNodeAndSubgraph(currentNode.id);

      for (const followingNodeId of this.getFollowingNodeIdsInGraph(currentNode)) {
        addNodeAndSubgraph(followingNodeId);
      }

      const currentGraphId = currentNode.graphId ?? ROOT_GRAPH_ID;
      const graph = this.snapshot.graphs?.find((candidate) => candidate.id === currentGraphId);

      if (!graph?.parentNodeId) {
        break;
      }

      currentNode = this.snapshot.nodes.find((candidate) => candidate.id === graph.parentNodeId);
    }

    return Array.from(rejectedNodeIds);
  }

  private getFollowingNodeIdsInGraph(node: MegaplanNode): string[] {
    const graphId = node.graphId ?? ROOT_GRAPH_ID;
    const graphNodeIds = new Set(this.getGraphNodes(graphId).map((candidate) => candidate.id));
    const graphEdges = this.snapshot.edges.filter((edge) => graphNodeIds.has(edge.source) && graphNodeIds.has(edge.target));
    return getDownstreamNodeIds(node.id, graphEdges);
  }

  private updateNodeDetails(nodeId: string, details: Pick<Partial<MegaplanNode>, 'title' | 'summary' | 'rationale'>): void {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot update missing node: ${nodeId}`, true);
      return;
    }

    const patch: Pick<Partial<MegaplanNode>, 'title' | 'summary' | 'rationale'> = {};
    const title = details.title?.trim();
    const summary = details.summary?.trim();
    const rationale = details.rationale?.trim();

    if (title) {
      patch.title = title;
    }

    if (summary) {
      patch.summary = summary;
    }

    if (details.rationale !== undefined) {
      patch.rationale = rationale || undefined;
    }

    if (Object.keys(patch).length > 0) {
      this.updateNode(nodeId, patch);
    }
  }

  private clearGraph(graphId: string): void {
    const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);

    if (!graph) {
      this.emitAgentError(`Cannot clear missing graph: ${graphId}`, true);
      return;
    }

    const nodeIdsToRemove = new Set<string>();
    const graphIdsToRemove = new Set<string>();
    this.collectGraphClearTargets(graphId, nodeIdsToRemove, graphIdsToRemove, false);

    if (nodeIdsToRemove.size === 0) {
      return;
    }

    const edgeIdsToRemove = this.snapshot.edges.filter((edge) => nodeIdsToRemove.has(edge.source) || nodeIdsToRemove.has(edge.target)).map((edge) => edge.id);
    const patches: Extract<BridgeEvent, { type: 'nodesUpdated' }>['patches'] = [];

    if (graph.parentNodeId && !nodeIdsToRemove.has(graph.parentNodeId)) {
      patches.push({
        id: graph.parentNodeId,
        patch: {
          abstraction: 'decomposable',
          childGraphId: graph.id,
          expandable: true,
          expanded: true,
          status: 'pending'
        }
      });
    }

    for (const toolUse of this.snapshot.pendingToolUses ?? []) {
      if (nodeIdsToRemove.has(toolUse.nodeId)) {
        this.graphRunApprovalToolUses.delete(toolUse.id);
        this.approvedToolUses.delete(toolUse.id);
        this.rejectedToolUses.delete(toolUse.id);
      }
    }

    this.runningGraphIds.delete(graphId);
    this.graphRunContextIds.delete(graphId);
    this.pendingGraphResumeIds.delete(graphId);

    for (const removedGraphId of graphIdsToRemove) {
      this.runningGraphIds.delete(removedGraphId);
      this.graphRunContextIds.delete(removedGraphId);
      this.pendingGraphResumeIds.delete(removedGraphId);
    }

    this.emit({ type: 'nodesUpdated', patches, removeIds: Array.from(nodeIdsToRemove), ...this.eventBase() });

    if (edgeIdsToRemove.length > 0) {
      this.emit({ type: 'edgesUpdated', removeIds: edgeIdsToRemove, ...this.eventBase() });
    }

    this.emit({
      type: 'graphsUpdated',
      upsert: [{ ...graph, status: 'idle', summary: undefined, updatedAt: new Date().toISOString() }],
      removeIds: Array.from(graphIdsToRemove),
      ...this.eventBase()
    });
  }

  private collectGraphClearTargets(graphId: string, nodeIdsToRemove: Set<string>, graphIdsToRemove: Set<string>, removeGraph: boolean): void {
    if (removeGraph) {
      graphIdsToRemove.add(graphId);
    }

    for (const node of this.getGraphNodes(graphId)) {
      nodeIdsToRemove.add(node.id);

      if (node.childGraphId) {
        this.collectGraphClearTargets(node.childGraphId, nodeIdsToRemove, graphIdsToRemove, true);
      }
    }
  }

  private deleteNode(nodeId: string): void {
    const node = this.snapshot.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      this.emitAgentError(`Cannot delete missing node: ${nodeId}`, true);
      return;
    }

    const impactedNodeIds = this.getRecursiveSubgraphNodeIds(nodeId);
    const invalidatedNodeIds = new Set([nodeId, ...impactedNodeIds]);

    for (const toolUse of this.snapshot.pendingToolUses ?? []) {
      if (toolUse.status === 'pending' && invalidatedNodeIds.has(toolUse.nodeId)) {
        this.rejectedToolUses.add(toolUse.id);
        this.graphRunApprovalToolUses.delete(toolUse.id);
        this.updateToolUse(toolUse.id, 'rejected');
      }
    }

    this.emit({ type: 'nodeInvalidated', nodeId, reason: 'Deleted by user.', impactedNodeIds, ...this.eventBase() });
  }

  private getRecursiveSubgraphNodeIds(nodeId: string): string[] {
    const impactedNodeIds = new Set<string>();
    const visitedNodeIds = new Set<string>();

    const visitNode = (currentNodeId: string): void => {
      if (visitedNodeIds.has(currentNodeId)) {
        return;
      }

      visitedNodeIds.add(currentNodeId);
      const currentNode = this.snapshot.nodes.find((candidate) => candidate.id === currentNodeId);

      if (!currentNode?.childGraphId) {
        return;
      }

      for (const childNode of this.getGraphNodes(currentNode.childGraphId)) {
        impactedNodeIds.add(childNode.id);
        visitNode(childNode.id);
      }
    };

    visitNode(nodeId);
    return Array.from(impactedNodeIds);
  }

  private refreshAncestorStatusesFrom(node: MegaplanNode): void {
    let parentId = node.parentId;

    while (parentId) {
      const parentNode = this.snapshot.nodes.find((candidate) => candidate.id === parentId);

      if (!parentNode?.childGraphId) {
        return;
      }

      this.updateParentNodeFromChildGraph(parentNode, parentNode.childGraphId);
      parentId = this.snapshot.nodes.find((candidate) => candidate.id === parentNode.id)?.parentId;
    }
  }

  private nodeDependenciesCompleted(node: MegaplanNode, graphId: string): boolean {
    const completed = new Set(this.snapshot.nodes.filter((candidate) => ['completed', 'approved'].includes(candidate.status)).map((candidate) => candidate.id));
    const graphNodeIds = new Set(this.snapshot.nodes.filter((candidate) => (candidate.graphId ?? ROOT_GRAPH_ID) === graphId).map((candidate) => candidate.id));
    const dependencies = this.snapshot.edges.filter((edge) => graphNodeIds.has(edge.source) && edge.target === node.id);
    return dependencies.every((edge) => completed.has(edge.source));
  }

  private isBlockedStatus(status: MegaplanNode['status']): boolean {
    return ['blocked', 'invalidated', 'rejected'].includes(status);
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
    return nodes.map((node) => {
      const terminal = this.isTerminalNode(node);

      return {
        ...node,
        graphId,
        parentId: node.parentId ?? fallbackParentId,
        summary: this.nodeSummary(node),
        expandable: terminal ? false : node.expandable,
        abstraction: terminal ? 'terminal' : node.abstraction ?? (node.expandable ? 'decomposable' : 'runnable')
      };
    });
  }

  private vetRootGraphNodes(nodes: MegaplanNode[], task: string): MegaplanNode[] {
    const allowNonCoding = this.taskAllowsNonCoding(task);
    const filteredNodes = this.deduplicateSimilarNodes(nodes
      .filter((node) => allowNonCoding || !this.hasNonCodingFocus(node))
      .filter((node) => allowNonCoding || !this.hasResearchScopeWithoutImplementationAnchor(node))
      .filter((node) => allowNonCoding || this.looksLikeCodingAgentStep(node) || !this.looksGenericPlanningStep(node)));

    if (filteredNodes.length >= 2 && (allowNonCoding || filteredNodes.some((node) => this.looksLikeCodingAgentStep(node)))) {
      return filteredNodes;
    }

    return this.normalizeNodes(this.defaultCodingRootNodes(task), ROOT_GRAPH_ID);
  }

  private defaultCodingRootNodes(task: string): MegaplanNode[] {
    return [
      {
        id: 'plan-inspect-codebase',
        title: 'Inspect codebase and task context',
        kind: 'task',
        phase: 'planning',
        status: 'pending',
        confidence: 0.8,
        summary: task,
        expandable: true,
        abstraction: 'decomposable',
        order: 1
      },
      {
        id: 'plan-design-code-changes',
        title: 'Design implementation approach',
        kind: 'decision',
        phase: 'planning',
        status: 'pending',
        confidence: 0.7,
        summary: 'Decide the app structure, data contracts, and code changes before implementation.',
        expandable: true,
        abstraction: 'decomposable',
        order: 2
      },
      {
        id: 'plan-implement-code-changes',
        title: 'Implement code changes',
        kind: 'action',
        phase: 'execution',
        status: 'pending',
        confidence: 0.65,
        summary: 'Modify the necessary files, components, services, and wiring for the requested app.',
        expandable: true,
        abstraction: 'decomposable',
        order: 3
      },
      {
        id: 'plan-validate-build',
        title: 'Validate with tests and build',
        kind: 'review',
        phase: 'review',
        status: 'pending',
        confidence: 0.75,
        summary: 'Run tests, typechecks, builds, and manual validation to confirm behavior.',
        expandable: true,
        abstraction: 'decomposable',
        order: 4
      }
    ];
  }

  private buildDecompositionContext(node: MegaplanNode, instructions?: string): { context: string; info: DecompositionContextInfo } {
    const ancestors = this.getAncestorNodes(node);
    const siblings = this.getGraphNodes(node.graphId ?? ROOT_GRAPH_ID).filter((candidate) => candidate.id !== node.id);
    const nodeDepth = ancestors.length;
    const recentContext = this.snapshot.eventLog?.slice(-20).map((event) => `${event.type}:${event.eventId}`).join('\n') ?? 'None.';
    const trimmedInstructions = instructions?.trim();
    const context = [
      `Original coding task:\n${this.snapshot.task ?? 'Unknown task.'}`,
      `Current node depth: ${nodeDepth}`,
      `Child graph depth: ${nodeDepth + 1}`,
      `Ancestor path:\n${this.formatNodesForContext([...ancestors, node])}`,
      `Sibling nodes already covering nearby work:\n${this.formatNodesForContext(siblings)}`,
      'Terminality rule: return empty nodes and empty edges if the current node can be completed as one focused coding-agent action or if deeper decomposition would repeat ancestor/sibling work.',
      trimmedInstructions ? `User construction instructions:\n${trimmedInstructions}` : undefined,
      `Recent event context:\n${recentContext}`
    ].filter((section): section is string => Boolean(section)).join('\n\n');

    return { context, info: { nodeDepth, ancestors, siblings } };
  }

  private vetDecompositionNodes(parentNode: MegaplanNode, nodes: MegaplanNode[], info: DecompositionContextInfo): MegaplanNode[] {
    if (nodes.length < 2) {
      return [];
    }

    const allowNonCoding = this.taskAllowsNonCoding(this.snapshot.task);
    const contextNodes = [parentNode, ...info.ancestors, ...info.siblings];
    const filteredNodes = this.deduplicateSimilarNodes(nodes
      .filter((node) => allowNonCoding || !this.hasNonCodingFocus(node))
      .filter((node) => allowNonCoding || !this.hasResearchScopeWithoutImplementationAnchor(node))
      .filter((node) => allowNonCoding || this.looksLikeCodingAgentStep(node) || !this.looksGenericPlanningStep(node))
      .filter((node) => !this.duplicatesContextNode(node, contextNodes)));

    if (filteredNodes.length < 2) {
      return [];
    }

    if (!allowNonCoding && filteredNodes.every((node) => !this.looksLikeCodingAgentStep(node))) {
      return [];
    }

    if (info.nodeDepth >= 2 && filteredNodes.filter((node) => this.looksLikeCodingAgentStep(node)).length < 2) {
      return [];
    }

    return filteredNodes;
  }

  private getAncestorNodes(node: MegaplanNode): MegaplanNode[] {
    const ancestors: MegaplanNode[] = [];
    const seenNodeIds = new Set<string>();
    let graphId = node.graphId ?? ROOT_GRAPH_ID;

    while (graphId !== ROOT_GRAPH_ID) {
      const graph = this.snapshot.graphs?.find((candidate) => candidate.id === graphId);
      const parentNodeId = graph?.parentNodeId;

      if (!parentNodeId || seenNodeIds.has(parentNodeId)) {
        break;
      }

      const parentNode = this.snapshot.nodes.find((candidate) => candidate.id === parentNodeId);

      if (!parentNode) {
        break;
      }

      ancestors.unshift(parentNode);
      seenNodeIds.add(parentNode.id);
      graphId = parentNode.graphId ?? ROOT_GRAPH_ID;
    }

    return ancestors;
  }

  private formatNodesForContext(nodes: MegaplanNode[]): string {
    if (nodes.length === 0) {
      return 'None.';
    }

    return nodes.map((node) => `- ${node.title}${node.summary ? `: ${node.summary}` : ''} [${node.abstraction ?? 'unspecified'}]`).join('\n');
  }

  private isTerminalNode(node: MegaplanNode): boolean {
    return node.abstraction === 'terminal' || node.abstraction === 'runnable' || node.expandable === false;
  }

  private nodeSummary(node: MegaplanNode): string {
    const summary = node.summary?.trim();
    return summary || `${node.title}.`;
  }

  private deduplicateSimilarNodes(nodes: MegaplanNode[]): MegaplanNode[] {
    const accepted: MegaplanNode[] = [];

    for (const node of nodes) {
      if (!accepted.some((candidate) => this.textSimilarity(node.title, candidate.title) >= 0.75)) {
        accepted.push(node);
      }
    }

    return accepted;
  }

  private duplicatesContextNode(node: MegaplanNode, contextNodes: MegaplanNode[]): boolean {
    return contextNodes.some((contextNode) => {
      const nodeTitle = this.normalizedText(node.title);
      const contextTitle = this.normalizedText(contextNode.title);
      return this.textSimilarity(node.title, contextNode.title) >= 0.66 || (nodeTitle.length > 0 && contextTitle.length > 0 && (nodeTitle.includes(contextTitle) || contextTitle.includes(nodeTitle)));
    });
  }

  private hasNonCodingFocus(node: MegaplanNode): boolean {
    return this.containsAnyTerm(this.nodeSearchText(node), NON_CODING_TERMS);
  }

  private hasResearchScopeWithoutImplementationAnchor(node: MegaplanNode): boolean {
    const text = this.nodeSearchText(node);
    return this.containsAnyTerm(text, RESEARCH_SCOPE_TERMS) && !this.containsAnyTerm(text, IMPLEMENTATION_ANCHOR_TERMS);
  }

  private looksGenericPlanningStep(node: MegaplanNode): boolean {
    return this.containsAnyTerm(this.normalizedText(node.title), GENERIC_PLANNING_TERMS);
  }

  private looksLikeCodingAgentStep(node: MegaplanNode): boolean {
    return this.containsAnyTerm(this.nodeSearchText(node), CODING_TERMS);
  }

  private taskAllowsNonCoding(task?: string): boolean {
    return this.containsAnyTerm(this.normalizedText(task ?? ''), EXPLICIT_NON_CODING_TERMS);
  }

  private nodeSearchText(node: MegaplanNode): string {
    return this.normalizedText(`${node.title} ${node.summary ?? ''} ${node.rationale ?? ''}`);
  }

  private containsAnyTerm(text: string, terms: string[]): boolean {
    return terms.some((term) => text.includes(term));
  }

  private textSimilarity(left: string, right: string): number {
    const leftTokens = new Set(this.textTokens(left));
    const rightTokens = new Set(this.textTokens(right));

    if (leftTokens.size === 0 || rightTokens.size === 0) {
      return 0;
    }

    const intersectionSize = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    const unionSize = new Set([...leftTokens, ...rightTokens]).size;
    return unionSize === 0 ? 0 : intersectionSize / unionSize;
  }

  private textTokens(text: string): string[] {
    return this.normalizedText(text)
      .split(' ')
      .map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  }

  private normalizedText(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private graphHasBlockedNodes(graphId: string): boolean {
    return this.snapshot.nodes.some((node) => (node.graphId ?? ROOT_GRAPH_ID) === graphId && node.status === 'blocked');
  }

  private graphHasRejectedNodes(graphId: string): boolean {
    return this.snapshot.nodes.some((node) => (node.graphId ?? ROOT_GRAPH_ID) === graphId && node.status === 'rejected');
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
