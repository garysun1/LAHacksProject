import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function loadProjectEnv(filename = '.env'): string | undefined {
  const envPath = findEnvFile(filename);

  if (!envPath) {
    return undefined;
  }

  const contents = readFileSync(envPath, 'utf8');

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = parseEnvValue(trimmed.slice(equalsIndex + 1).trim());
  }

  return envPath;
}

function findEnvFile(filename: string): string | undefined {
  const startDirectories = [process.cwd(), __dirname].map((directory) => resolve(directory));
  const checked = new Set<string>();

  for (const startDirectory of startDirectories) {
    let currentDirectory = startDirectory;

    while (!checked.has(currentDirectory)) {
      checked.add(currentDirectory);

      const envPath = join(currentDirectory, filename);

      if (existsSync(envPath)) {
        return envPath;
      }

      const parentDirectory = dirname(currentDirectory);

      if (parentDirectory === currentDirectory) {
        break;
      }

      currentDirectory = parentDirectory;
    }
  }

  return undefined;
}

function parseEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
