import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertWorkspacePath } from './toolPolicy';

export async function listWorkspaceFiles(workspaceRoot: string, relativeDir = '.', maxEntries = 200): Promise<string[]> {
  const absoluteDir = assertWorkspacePath(workspaceRoot, relativeDir);
  const results: string[] = [];

  async function walk(directory: string): Promise<void> {
    if (results.length >= maxEntries) {
      return;
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxEntries || entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspaceRoot, absolutePath);

      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }

  await walk(absoluteDir);
  return results;
}

export async function readWorkspaceFile(workspaceRoot: string, relativePath: string, maxBytes = 80_000): Promise<string> {
  const absolutePath = assertWorkspacePath(workspaceRoot, relativePath);
  const buffer = await fs.readFile(absolutePath);
  return buffer.subarray(0, maxBytes).toString('utf8');
}

export async function searchWorkspace(workspaceRoot: string, query: string, maxResults = 50): Promise<Array<{ path: string; line: number; text: string }>> {
  const files = await listWorkspaceFiles(workspaceRoot, '.', 500);
  const results: Array<{ path: string; line: number; text: string }> = [];

  for (const file of files) {
    if (results.length >= maxResults) {
      break;
    }

    try {
      const content = await readWorkspaceFile(workspaceRoot, file, 40_000);
      const lines = content.split('\n');

      lines.forEach((lineText, index) => {
        if (results.length < maxResults && lineText.toLowerCase().includes(query.toLowerCase())) {
          results.push({ path: file, line: index + 1, text: lineText });
        }
      });
    } catch {
      // Ignore unreadable or binary-ish files.
    }
  }

  return results;
}

export async function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = assertWorkspacePath(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
}
