import { describe, expect, it } from 'vitest';
import { assertWorkspacePath, evaluateCommand } from './toolPolicy';

describe('toolPolicy', () => {
  it('keeps paths inside the workspace root', () => {
    expect(assertWorkspacePath('/tmp/workspace', 'src/index.ts')).toBe('/tmp/workspace/src/index.ts');
    expect(() => assertWorkspacePath('/tmp/workspace', '../secret.txt')).toThrow('escapes workspace');
  });

  it('allows safe validation commands and gates other commands', () => {
    expect(evaluateCommand('npm run typecheck')).toEqual({ allowed: true, requiresApproval: false });
    expect(evaluateCommand('npm install left-pad').requiresApproval).toBe(true);
  });
});
