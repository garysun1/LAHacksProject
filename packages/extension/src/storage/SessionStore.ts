import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertAcyclic, graphSnapshotSchema, type MegaplanGraphSnapshot } from '@megaplan/shared';

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.sessionsDir = path.join(workspaceRoot, '.megaplan', 'sessions');
  }

  async save(snapshot: MegaplanGraphSnapshot): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filePath = this.getSessionPath(snapshot.sessionId);
    await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }

  async load(sessionId: string): Promise<MegaplanGraphSnapshot | undefined> {
    try {
      const content = await fs.readFile(this.getSessionPath(sessionId), 'utf8');
      return this.parseSnapshot(content);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }

      throw new Error(`Failed to load Megaplan session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadLatest(): Promise<MegaplanGraphSnapshot | undefined> {
    try {
      const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
      const stats = await Promise.all(files.map(async (file) => ({
        file,
        stat: await fs.stat(path.join(this.sessionsDir, file.name))
      })));
      const latestFirst = stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

      for (const candidate of latestFirst) {
        try {
          const content = await fs.readFile(path.join(this.sessionsDir, candidate.file.name), 'utf8');
          return this.parseSnapshot(content);
        } catch {
          continue;
        }
      }

      return undefined;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  private parseSnapshot(content: string): MegaplanGraphSnapshot {
    const snapshot = graphSnapshotSchema.parse(JSON.parse(content)) as MegaplanGraphSnapshot;
    assertAcyclic(snapshot.nodes, snapshot.edges);
    return snapshot;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
