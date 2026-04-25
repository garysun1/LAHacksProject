import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '@megaplan/shared';
import { SessionStore } from './SessionStore';

const tempDirs: string[] = [];

describe('SessionStore', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  it('round trips valid session snapshots', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const store = new SessionStore(workspaceRoot);
    const snapshot = {
      ...createEmptySnapshot('session-1', 'http://127.0.0.1:37241'),
      task: 'Persist me'
    };

    await store.save(snapshot);

    await expect(store.load('session-1')).resolves.toMatchObject({
      sessionId: 'session-1',
      task: 'Persist me'
    });
  });

  it('rejects malformed configured sessions with a helpful error', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const store = new SessionStore(workspaceRoot);
    const sessionsDir = path.join(workspaceRoot, '.megaplan', 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 'bad-session.json'), '{"schemaVersion":1}', 'utf8');

    await expect(store.load('bad-session')).rejects.toThrow('Failed to load Megaplan session bad-session');
  });

  it('skips malformed latest sessions and restores the newest valid fallback', async () => {
    const workspaceRoot = await makeTempWorkspace();
    const store = new SessionStore(workspaceRoot);
    const validSnapshot = createEmptySnapshot('valid-session');
    await store.save(validSnapshot);

    const sessionsDir = path.join(workspaceRoot, '.megaplan', 'sessions');
    const invalidPath = path.join(sessionsDir, 'invalid-session.json');
    await fs.writeFile(invalidPath, 'not json', 'utf8');
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(invalidPath, future, future);

    await expect(store.loadLatest()).resolves.toMatchObject({ sessionId: 'valid-session' });
  });
});

async function makeTempWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'megaplan-store-'));
  tempDirs.push(directory);
  return directory;
}
