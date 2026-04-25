import { spawn } from 'node:child_process';
import { evaluateCommand } from './toolPolicy';

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runAllowedCommand(workspaceRoot: string, command: string): Promise<CommandResult> {
  const decision = evaluateCommand(command);

  if (!decision.allowed || decision.requiresApproval) {
    throw new Error(decision.reason ?? 'Command requires approval.');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: workspaceRoot,
      shell: true,
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
