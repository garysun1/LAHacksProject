import OpenAI from 'openai';
import { decisionAlternativeSchema, megaplanEdgeSchema, megaplanNodeSchema, type DecisionAlternative, type MegaplanEdge, type MegaplanNode } from '@megaplan/shared';
import { z } from 'zod';

export type GraphProposal = {
  nodes: MegaplanNode[];
  edges: MegaplanEdge[];
};

export type ExecutionResult = {
  summary: string;
  rationale: string;
  confidence: number;
  observations: string[];
  proposedPatch?: {
    path: string;
    content: string;
    description: string;
  };
  alternatives?: DecisionAlternative[];
};

const graphProposalSchema = z.object({
  nodes: z.array(megaplanNodeSchema),
  edges: z.array(megaplanEdgeSchema)
});

const executionResultSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  observations: z.array(z.string()),
  proposedPatch: z.object({
    path: z.string(),
    content: z.string(),
    description: z.string()
  }).optional(),
  alternatives: z.array(decisionAlternativeSchema).optional()
});

export class OpenAiAgent {
  private readonly client?: OpenAI;

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    this.client = apiKey ? new OpenAI({ apiKey }) : undefined;
  }

  get configured(): boolean {
    return Boolean(this.client);
  }

  async planTask(sessionId: string, task: string): Promise<GraphProposal> {
    const fallback = this.fallbackPlan(task);

    if (!this.client) {
      return fallback;
    }

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You decompose coding tasks into a concise recursive sequence graph for Megaplan. Each graph is an ordered list of distinct steps; use only sequence edges, avoid dependency/entailment/invalidates semantics, mark broad steps as decomposable, and return graph data only through the provided tool.'
        },
        {
          role: 'user',
          content: `Session: ${sessionId}\nTask: ${task}`
        }
      ],
      tools: [createGraphTool()],
      tool_choice: { type: 'function', function: { name: 'create_or_update_graph' } }
    });

    return parseGraphToolCall(response) ?? fallback;
  }

  async decomposeNode(sessionId: string, node: MegaplanNode, context: string): Promise<GraphProposal> {
    const fallback = this.fallbackDecomposition(node);

    if (!this.client) {
      return fallback;
    }

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You lazily decompose one Megaplan graph node into a focused child sequence graph. Keep IDs stable, use the parent ID, make child nodes concrete, use only sequence edges between naturally ordered steps, and return graph data only through the tool.'
        },
        {
          role: 'user',
          content: `Session: ${sessionId}\nNode: ${JSON.stringify(node)}\nContext: ${context}`
        }
      ],
      tools: [createGraphTool()],
      tool_choice: { type: 'function', function: { name: 'create_or_update_graph' } }
    });

    return parseGraphToolCall(response) ?? fallback;
  }

  async executeNode(node: MegaplanNode, workspaceSummary: string): Promise<ExecutionResult> {
    const fallback: ExecutionResult = {
      summary: `Completed ${node.title}`,
      rationale: 'Fallback execution result produced without a configured OpenAI client.',
      confidence: 0.35,
      observations: [`Node ${node.id} was marked complete by the local bridge-agent fallback.`]
    };

    if (!this.client) {
      return fallback;
    }

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You execute one coding-agent graph node. If the node is still abstract, surface observations or alternatives instead of pretending it is complete. If a file change is needed, propose it rather than claiming it was applied.'
        },
        {
          role: 'user',
          content: `Node: ${JSON.stringify(node)}\nWorkspace summary:\n${workspaceSummary}`
        }
      ],
      tools: [executionResultTool()],
      tool_choice: { type: 'function', function: { name: 'record_execution_result' } }
    });

    return parseExecutionToolCall(response) ?? fallback;
  }

  private fallbackPlan(task: string): GraphProposal {
    const nodes: MegaplanNode[] = [
      {
        id: 'plan-understand-task',
        title: 'Understand task and inspect workspace',
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
        id: 'plan-design-approach',
        title: 'Design implementation approach',
        kind: 'decision',
        phase: 'planning',
        status: 'pending',
        confidence: 0.6,
        expandable: true,
        abstraction: 'decomposable',
        order: 2,
        alternatives: [
          { id: 'mvp-first', title: 'MVP first', summary: 'Build the smallest working vertical slice.', tradeoffs: ['Fast validation', 'Less complete initially'], recommended: true },
          { id: 'full-stack-first', title: 'Full stack first', summary: 'Build all layers before polishing interactions.', tradeoffs: ['Broader coverage', 'More integration risk'] }
        ]
      },
      {
        id: 'plan-implement',
        title: 'Implement selected changes',
        kind: 'action',
        phase: 'execution',
        status: 'pending',
        confidence: 0.55,
        expandable: true,
        abstraction: 'decomposable',
        order: 3
      },
      {
        id: 'plan-review',
        title: 'Review artifacts and confidence',
        kind: 'review',
        phase: 'review',
        status: 'pending',
        confidence: 0.75,
        expandable: true,
        abstraction: 'decomposable',
        order: 4
      }
    ];

    return {
      nodes,
      edges: [
        { id: 'edge-understand-design', source: nodes[0].id, target: nodes[1].id, kind: 'sequence' },
        { id: 'edge-design-implement', source: nodes[1].id, target: nodes[2].id, kind: 'sequence' },
        { id: 'edge-implement-review', source: nodes[2].id, target: nodes[3].id, kind: 'sequence' }
      ]
    };
  }

  private fallbackDecomposition(node: MegaplanNode): GraphProposal {
    const childA: MegaplanNode = {
      id: `${node.id}-inspect`,
      parentId: node.id,
      title: `Inspect context for ${node.title}`,
      kind: 'observation',
      phase: node.phase,
      status: 'pending',
      confidence: 0.6,
      abstraction: 'runnable',
      order: 1
    };
    const childB: MegaplanNode = {
      id: `${node.id}-act`,
      parentId: node.id,
      title: `Act on ${node.title}`,
      kind: 'action',
      phase: node.phase,
      status: 'pending',
      confidence: 0.55,
      abstraction: 'runnable',
      order: 2
    };

    return {
      nodes: [childA, childB],
      edges: [{ id: `${childA.id}-${childB.id}`, source: childA.id, target: childB.id, kind: 'sequence' }]
    };
  }
}

function createGraphTool(): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: 'create_or_update_graph',
      description: 'Create or update a Megaplan graph with nodes and edges.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['nodes', 'edges'],
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['id', 'title', 'kind', 'phase', 'status'],
              properties: {
                id: { type: 'string' },
                graphId: { type: 'string' },
                parentId: { type: 'string' },
                childGraphId: { type: 'string' },
                title: { type: 'string' },
                kind: { enum: ['task', 'decision', 'action', 'review', 'observation', 'approval'] },
                phase: { enum: ['planning', 'execution', 'review'] },
                status: { enum: ['pending', 'active', 'completed', 'blocked', 'invalidated', 'approved', 'rejected'] },
                abstraction: { enum: ['abstract', 'decomposable', 'runnable', 'terminal'] },
                confidence: { type: 'number' },
                summary: { type: 'string' },
                rationale: { type: 'string' },
                expandable: { type: 'boolean' },
                order: { type: 'number' }
              }
            }
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'source', 'target', 'kind'],
              properties: {
                id: { type: 'string' },
                source: { type: 'string' },
                target: { type: 'string' },
                kind: { enum: ['sequence'] }
              }
            }
          }
        }
      }
    }
  };
}

function executionResultTool(): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: 'record_execution_result',
      description: 'Record the outcome of executing a graph node.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'rationale', 'confidence', 'observations'],
        properties: {
          summary: { type: 'string' },
          rationale: { type: 'string' },
          confidence: { type: 'number' },
          observations: { type: 'array', items: { type: 'string' } },
          proposedPatch: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'content', 'description'],
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              description: { type: 'string' }
            }
          },
          alternatives: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'summary', 'tradeoffs'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                tradeoffs: { type: 'array', items: { type: 'string' } },
                recommended: { type: 'boolean' },
                status: { enum: ['candidate', 'selected', 'rejected'] },
                promotedGraphId: { type: 'string' }
              }
            }
          }
        }
      }
    }
  };
}

function parseGraphToolCall(response: OpenAI.Chat.Completions.ChatCompletion): GraphProposal | undefined {
  const args = firstToolArguments(response);

  if (!args) {
    return undefined;
  }

  const parsed = graphProposalSchema.safeParse(args);
  return parsed.success ? parsed.data : undefined;
}

function parseExecutionToolCall(response: OpenAI.Chat.Completions.ChatCompletion): ExecutionResult | undefined {
  const args = firstToolArguments(response);

  if (!args) {
    return undefined;
  }

  const parsed = executionResultSchema.safeParse(args);
  return parsed.success ? parsed.data : undefined;
}

function firstToolArguments(response: OpenAI.Chat.Completions.ChatCompletion): unknown | undefined {
  const toolCall = response.choices[0]?.message.tool_calls?.[0];

  if (!toolCall || toolCall.type !== 'function') {
    return undefined;
  }

  try {
    return JSON.parse(toolCall.function.arguments) as unknown;
  } catch {
    return undefined;
  }
}
