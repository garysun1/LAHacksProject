import * as path from 'node:path';

const defaultAllowedCommands = new Set([
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run typecheck',
  'npm run compile'
]);

export type ToolPolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
};

export function assertWorkspacePath(workspaceRoot: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(workspaceRoot, candidatePath);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${candidatePath}`);
  }

  return resolvedPath;
}

export function evaluateCommand(command: string): ToolPolicyDecision {
  const normalized = command.trim();

  if (defaultAllowedCommands.has(normalized)) {
    return { allowed: true, requiresApproval: false };
  }

  if (/\b(rm|sudo|curl|wget|brew|npm install|pnpm add|yarn add)\b/.test(normalized)) {
    return { allowed: false, requiresApproval: true, reason: 'Command may mutate the system or install dependencies.' };
  }

  return { allowed: true, requiresApproval: true, reason: 'Command is not on the allowlist.' };
}

export function fileWriteRequiresApproval(): ToolPolicyDecision {
  return { allowed: true, requiresApproval: true, reason: 'File writes require explicit approval.' };
}
