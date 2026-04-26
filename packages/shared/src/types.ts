export type NodeKind = 'task' | 'decision' | 'action' | 'review' | 'observation' | 'approval';

export type GraphPhase = 'planning' | 'execution' | 'review';

export type NodeStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'invalidated' | 'approved' | 'rejected';

export type EdgeKind = 'sequence';

export type ArtifactKind = 'file' | 'range' | 'patch' | 'command' | 'observation' | 'diagnostic' | 'tool';

export type ToolUseKind = 'patch' | 'command';

export type NodeAbstraction = 'abstract' | 'decomposable' | 'runnable' | 'terminal';

export type AlternativeStatus = 'candidate' | 'selected' | 'rejected';

export type GraphRunStatus = 'idle' | 'running' | 'completed' | 'blocked' | 'error';

export type DecisionAlternative = {
  id: string;
  title: string;
  summary: string;
  tradeoffs: string[];
  recommended?: boolean;
  status?: AlternativeStatus;
};

export type MegaplanGraphScope = {
  id: string;
  title: string;
  parentNodeId?: string;
  status: GraphRunStatus;
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

export type NodeArtifact = {
  id: string;
  kind: ArtifactKind;
  title: string;
  path?: string;
  uri?: string;
  range?: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  content?: string;
  metadata?: Record<string, unknown>;
};

export type MegaplanNode = {
  id: string;
  graphId?: string;
  parentId?: string;
  childGraphId?: string;
  title: string;
  kind: NodeKind;
  phase: GraphPhase;
  status: NodeStatus;
  abstraction?: NodeAbstraction;
  confidence?: number;
  summary: string;
  rationale?: string;
  alternatives?: DecisionAlternative[];
  selectedAlternativeId?: string;
  pinned?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  entailedBy?: string[];
  artifacts?: NodeArtifact[];
  order?: number;
};

export type MegaplanEdge = {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
};

export type ToolUseRequest = {
  id: string;
  kind: ToolUseKind;
  nodeId: string;
  title: string;
  description: string;
  path?: string;
  command?: string;
  cwd?: string;
  proposedContent?: string;
  patch?: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
};

export type MegaplanGraphSnapshot = {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  rootGraphId?: string;
  focusedGraphId?: string;
  task?: string;
  phase: GraphPhase;
  graphs?: MegaplanGraphScope[];
  nodes: MegaplanNode[];
  edges: MegaplanEdge[];
  activeNodeId?: string;
  activeGraphId?: string;
  bridgeBaseUrl?: string;
  eventLog?: BridgeEvent[];
  pendingToolUses?: ToolUseRequest[];
};

export type BridgeEventBase = {
  eventId: string;
  sessionId: string;
  timestamp: string;
};

export type SessionSnapshotEvent = BridgeEventBase & {
  type: 'sessionSnapshot';
  snapshot: MegaplanGraphSnapshot;
};

export type NodesAddedEvent = BridgeEventBase & {
  type: 'nodesAdded';
  nodes: MegaplanNode[];
  edges?: MegaplanEdge[];
};

export type NodesUpdatedEvent = BridgeEventBase & {
  type: 'nodesUpdated';
  patches: Array<{
    id: string;
    patch: Partial<MegaplanNode>;
  }>;
};

export type EdgesUpdatedEvent = BridgeEventBase & {
  type: 'edgesUpdated';
  upsert?: MegaplanEdge[];
  removeIds?: string[];
};

export type GraphsUpdatedEvent = BridgeEventBase & {
  type: 'graphsUpdated';
  upsert?: MegaplanGraphScope[];
  removeIds?: string[];
};

export type ActiveNodeChangedEvent = BridgeEventBase & {
  type: 'activeNodeChanged';
  activeNodeId?: string;
};

export type GraphFocusedEvent = BridgeEventBase & {
  type: 'graphFocused';
  graphId: string;
};

export type GraphRunStateChangedEvent = BridgeEventBase & {
  type: 'graphRunStateChanged';
  graphId: string;
  status: GraphRunStatus;
  message?: string;
};

export type NodeInvalidatedEvent = BridgeEventBase & {
  type: 'nodeInvalidated';
  nodeId: string;
  reason?: string;
  impactedNodeIds?: string[];
};

export type AlternativesProposedEvent = BridgeEventBase & {
  type: 'alternativesProposed';
  nodeId: string;
  alternatives: DecisionAlternative[];
};

export type ApprovalRequestedEvent = BridgeEventBase & {
  type: 'approvalRequested';
  toolUse: ToolUseRequest;
};

export type ToolUseUpdatedEvent = BridgeEventBase & {
  type: 'toolUseUpdated';
  toolUseId: string;
  patch: Partial<ToolUseRequest>;
};

export type ArtifactLinkedEvent = BridgeEventBase & {
  type: 'artifactLinked';
  nodeId: string;
  artifact: NodeArtifact;
};

export type AgentErrorEvent = BridgeEventBase & {
  type: 'agentError';
  message: string;
  recoverable?: boolean;
  details?: unknown;
};

export type BridgeEvent =
  | SessionSnapshotEvent
  | NodesAddedEvent
  | NodesUpdatedEvent
  | EdgesUpdatedEvent
  | GraphsUpdatedEvent
  | ActiveNodeChangedEvent
  | GraphFocusedEvent
  | GraphRunStateChangedEvent
  | NodeInvalidatedEvent
  | AlternativesProposedEvent
  | ApprovalRequestedEvent
  | ToolUseUpdatedEvent
  | ArtifactLinkedEvent
  | AgentErrorEvent;

export type HumanCommandBase = {
  commandId: string;
  sessionId: string;
  timestamp: string;
};

export type HumanCommand =
  | (HumanCommandBase & { type: 'startTask'; task: string; workspaceRoot?: string })
  | (HumanCommandBase & { type: 'decomposeNode'; nodeId: string })
  | (HumanCommandBase & { type: 'openNodeGraph'; nodeId: string })
  | (HumanCommandBase & { type: 'constructGraph'; graphId?: string; instructions?: string; workspaceRoot?: string })
  | (HumanCommandBase & { type: 'focusGraph'; graphId: string })
  | (HumanCommandBase & { type: 'runGraph'; graphId?: string })
  | (HumanCommandBase & { type: 'runNode'; nodeId: string })
  | (HumanCommandBase & { type: 'reorderNodes'; parentId?: string; orderedNodeIds: string[] })
  | (HumanCommandBase & { type: 'deleteNode'; nodeId: string })
  | (HumanCommandBase & { type: 'updateNodeDetails'; nodeId: string; title?: string; summary?: string; rationale?: string })
  | (HumanCommandBase & { type: 'pinNode'; nodeId: string; pinned: boolean })
  | (HumanCommandBase & { type: 'selectAlternative'; nodeId: string; alternativeId: string })
  | (HumanCommandBase & { type: 'approveNode'; nodeId: string })
  | (HumanCommandBase & { type: 'rejectNode'; nodeId: string; reason?: string })
  | (HumanCommandBase & { type: 'approveToolUse'; toolUseId: string })
  | (HumanCommandBase & { type: 'rejectToolUse'; toolUseId: string; reason?: string })
  | (HumanCommandBase & { type: 'requestReplan'; nodeIds?: string[]; reason?: string });

export type BridgeConnectionState = {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  bridgeBaseUrl: string;
  message?: string;
};

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'connect' }
  | { type: 'command'; command: Omit<HumanCommand, 'commandId' | 'sessionId' | 'timestamp'> };

export type ExtensionToWebviewMessage =
  | { type: 'state'; snapshot: MegaplanGraphSnapshot; connection: BridgeConnectionState }
  | { type: 'event'; event: BridgeEvent; snapshot: MegaplanGraphSnapshot }
  | { type: 'connection'; connection: BridgeConnectionState }
  | { type: 'error'; message: string };
