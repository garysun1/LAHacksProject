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
          content: 'You are planning work for a coding agent operating inside an IDE. Interpret vague app ideas as software-building tasks to implement in code, not as research, product strategy, or ML literature review. Do not produce business, stakeholder, marketing, sales, interview, generic project-management, literature-review, AI-model-survey, technology-comparison, paper-reading, conceptual-analysis, or architecture-research steps unless the user explicitly asks for that non-coding research. Decompose coding tasks into a concise recursive sequence graph for Megaplan. For root task graphs, produce 3-5 ordered top-level nodes unless the task is truly atomic; avoid returning one catch-all node. Each top-level node should represent a distinct, actionable IDE coding-agent phase: inspect the existing workspace, define app surfaces/data/contracts, implement files/components/services/routes/state, wire integrations/API calls, add tests, run typechecks/builds, debug failures, and validate behavior. Prefer verbs like inspect code, locate files, implement, update, wire, add tests, run build, and validate. Avoid verbs like research, review papers, evaluate technologies, analyze model architectures, compare frameworks, or identify best practices unless directly tied to editing or testing code. Use only sequence edges, avoid dependency/entailment/invalidates semantics, mark broad or ambiguous coding steps as decomposable, mark unambiguous one-way coding steps as terminal or runnable, and return graph data only through the provided tool.'
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
          content: 'You are decomposing work for a coding agent operating inside an IDE. Produce child nodes only for concrete IDE coding-agent work: inspect files, locate code paths, update code, add components/services/routes/schemas, wire UI or APIs, integrate model/API calls, add tests, run typechecks/builds, debug failures, and validate behavior. Do not produce business, stakeholder, marketing, sales, interview, generic project-management, literature-review, AI-model-survey, technology-comparison, paper-reading, conceptual-analysis, or architecture-research steps unless the original user task explicitly asks for that kind of research. Lazily decompose one Megaplan graph node into a focused child sequence graph. Produce 2-5 ordered child nodes only when they are distinct, actionable implementation steps that together comprise the parent node; avoid repeating the parent intent, duplicating ancestor/sibling responsibilities from the provided context, or returning one catch-all child node. If the parent node is already unambiguous, terminal, has only one obvious way to complete it, is primarily research/conceptual, or is at depth 2+ without multiple independent coding actions, return an empty nodes array and empty edges array. Keep IDs stable, use the parent ID, make child nodes concrete and code-editable, use only sequence edges between naturally ordered implementation steps, and return graph data only through the tool.'
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
        summary: 'Choose the implementation shape, affected files, and integration points before editing code.',
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
        summary: 'Apply the selected implementation changes in the workspace.',
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
        summary: 'Review generated artifacts, run validations, and assess confidence in the result.',
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
      summary: `Inspect files and context needed for ${node.title}.`,
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
      summary: `Make the concrete code or validation change for ${node.title}.`,
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
              required: ['id', 'title', 'kind', 'phase', 'status', 'summary'],
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
                status: { enum: ['candidate', 'selected', 'rejected'] }
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
