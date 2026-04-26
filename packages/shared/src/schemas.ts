import { z } from 'zod';

export const graphPhaseSchema = z.enum(['planning', 'execution', 'review']);
export const nodeStatusSchema = z.enum(['pending', 'active', 'completed', 'blocked', 'invalidated', 'approved', 'rejected']);
export const nodeKindSchema = z.enum(['task', 'decision', 'action', 'review', 'observation', 'approval']);
export const edgeKindSchema = z.enum(['sequence']);
export const nodeAbstractionSchema = z.enum(['abstract', 'decomposable', 'runnable', 'terminal']);
export const alternativeStatusSchema = z.enum(['candidate', 'selected', 'rejected']);
export const graphRunStatusSchema = z.enum(['idle', 'running', 'completed', 'blocked', 'error']);

export const decisionAlternativeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  tradeoffs: z.array(z.string()),
  recommended: z.boolean().optional(),
  status: alternativeStatusSchema.optional(),
  promotedGraphId: z.string().optional()
});

export const megaplanGraphScopeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  parentNodeId: z.string().optional(),
  status: graphRunStatusSchema,
  summary: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export const nodeArtifactSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['file', 'range', 'patch', 'command', 'observation', 'diagnostic', 'tool']),
  title: z.string().min(1),
  path: z.string().optional(),
  uri: z.string().optional(),
  range: z.object({
    startLine: z.number().int().nonnegative(),
    startCharacter: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    endCharacter: z.number().int().nonnegative()
  }).optional(),
  content: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const megaplanNodeSchema = z.object({
  id: z.string().min(1),
  graphId: z.string().optional(),
  parentId: z.string().optional(),
  childGraphId: z.string().optional(),
  title: z.string().min(1),
  kind: nodeKindSchema,
  phase: graphPhaseSchema,
  status: nodeStatusSchema,
  abstraction: nodeAbstractionSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  summary: z.string().min(1),
  rationale: z.string().optional(),
  alternatives: z.array(decisionAlternativeSchema).optional(),
  selectedAlternativeId: z.string().optional(),
  pinned: z.boolean().optional(),
  expandable: z.boolean().optional(),
  expanded: z.boolean().optional(),
  entailedBy: z.array(z.string()).optional(),
  artifacts: z.array(nodeArtifactSchema).optional(),
  order: z.number().optional()
});

export const megaplanEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  kind: edgeKindSchema
});

export const toolUseRequestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['patch', 'command']),
  nodeId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  path: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  proposedContent: z.string().optional(),
  patch: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed'])
});

export const bridgeEventBaseSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.string().min(1)
});

export const graphSnapshotSchema: z.ZodType<unknown> = z.lazy(() => z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  rootGraphId: z.string().optional(),
  focusedGraphId: z.string().optional(),
  task: z.string().optional(),
  phase: graphPhaseSchema,
  graphs: z.array(megaplanGraphScopeSchema).optional(),
  nodes: z.array(megaplanNodeSchema),
  edges: z.array(megaplanEdgeSchema),
  activeNodeId: z.string().optional(),
  activeGraphId: z.string().optional(),
  bridgeBaseUrl: z.string().optional(),
  eventLog: z.array(bridgeEventSchema).optional(),
  pendingToolUses: z.array(toolUseRequestSchema).optional()
}));

export const bridgeEventSchema: z.ZodType<unknown> = z.lazy(() => z.discriminatedUnion('type', [
  bridgeEventBaseSchema.extend({
    type: z.literal('sessionSnapshot'),
    snapshot: graphSnapshotSchema
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('nodesAdded'),
    nodes: z.array(megaplanNodeSchema),
    edges: z.array(megaplanEdgeSchema).optional()
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('nodesUpdated'),
    patches: z.array(z.object({
      id: z.string().min(1),
      patch: megaplanNodeSchema.partial()
    }))
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('edgesUpdated'),
    upsert: z.array(megaplanEdgeSchema).optional(),
    removeIds: z.array(z.string()).optional()
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('graphsUpdated'),
    upsert: z.array(megaplanGraphScopeSchema).optional(),
    removeIds: z.array(z.string()).optional()
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('activeNodeChanged'),
    activeNodeId: z.string().optional()
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('graphFocused'),
    graphId: z.string().min(1)
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('graphRunStateChanged'),
    graphId: z.string().min(1),
    status: graphRunStatusSchema,
    message: z.string().optional()
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('nodeInvalidated'),
    nodeId: z.string().min(1),
    reason: z.string().optional(),
    impactedNodeIds: z.array(z.string()).optional()
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('alternativesProposed'),
    nodeId: z.string().min(1),
    alternatives: z.array(decisionAlternativeSchema)
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('approvalRequested'),
    toolUse: toolUseRequestSchema
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('toolUseUpdated'),
    toolUseId: z.string().min(1),
    patch: toolUseRequestSchema.partial()
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('artifactLinked'),
    nodeId: z.string().min(1),
    artifact: nodeArtifactSchema
  }),
  bridgeEventBaseSchema.extend({
    type: z.literal('agentError'),
    message: z.string(),
    recoverable: z.boolean().optional(),
    details: z.unknown().optional()
  })
]));

export const humanCommandBaseSchema = z.object({
  commandId: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.string().min(1)
});

export const humanCommandSchema = z.discriminatedUnion('type', [
  humanCommandBaseSchema.extend({ type: z.literal('startTask'), task: z.string().min(1), workspaceRoot: z.string().optional() }),
  humanCommandBaseSchema.extend({ type: z.literal('decomposeNode'), nodeId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('openNodeGraph'), nodeId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('constructGraph'), graphId: z.string().optional(), instructions: z.string().optional(), workspaceRoot: z.string().optional() }),
  humanCommandBaseSchema.extend({ type: z.literal('focusGraph'), graphId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('runGraph'), graphId: z.string().optional() }),
  humanCommandBaseSchema.extend({ type: z.literal('runNode'), nodeId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('reorderNodes'), parentId: z.string().optional(), orderedNodeIds: z.array(z.string()) }),
  humanCommandBaseSchema.extend({ type: z.literal('deleteNode'), nodeId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('pinNode'), nodeId: z.string().min(1), pinned: z.boolean() }),
  humanCommandBaseSchema.extend({ type: z.literal('selectAlternative'), nodeId: z.string().min(1), alternativeId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('promoteAlternative'), nodeId: z.string().min(1), alternativeId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('approveNode'), nodeId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('rejectNode'), nodeId: z.string().min(1), reason: z.string().optional() }),
  humanCommandBaseSchema.extend({ type: z.literal('approveToolUse'), toolUseId: z.string().min(1) }),
  humanCommandBaseSchema.extend({ type: z.literal('rejectToolUse'), toolUseId: z.string().min(1), reason: z.string().optional() }),
  humanCommandBaseSchema.extend({ type: z.literal('requestReplan'), nodeIds: z.array(z.string()).optional(), reason: z.string().optional() })
]);
