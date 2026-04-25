import * as vscode from 'vscode';
import { createEmptySnapshot, reduceBridgeEvent, type BridgeConnectionState, type BridgeEvent, type HumanCommand, type MegaplanGraphSnapshot } from '@megaplan/shared';
import { HttpSseBridgeClient } from '../bridge/HttpSseBridgeClient';
import { SessionStore } from '../storage/SessionStore';

export type GraphControllerHandlers = {
  onSnapshot: (snapshot: MegaplanGraphSnapshot, connection: BridgeConnectionState) => void;
  onEvent: (event: BridgeEvent, snapshot: MegaplanGraphSnapshot) => void;
  onConnection: (connection: BridgeConnectionState) => void;
  onError: (message: string) => void;
};

export class GraphController {
  private snapshot: MegaplanGraphSnapshot;
  private bridgeClient?: HttpSseBridgeClient;
  private saveTimer?: NodeJS.Timeout;
  private connection: BridgeConnectionState;

  constructor(
    private readonly workspaceRoot: string,
    private readonly store: SessionStore,
    private readonly handlers: GraphControllerHandlers,
    private readonly bridgeBaseUrl: string,
    private readonly sessionId: string
  ) {
    this.snapshot = createEmptySnapshot(sessionId, bridgeBaseUrl);
    this.connection = { status: 'disconnected', bridgeBaseUrl };
  }

  async initialize(): Promise<void> {
    let configuredSession: MegaplanGraphSnapshot | undefined;

    try {
      configuredSession = await this.store.load(this.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handlers.onError(message);
    }

    const latestSession = configuredSession ?? await this.store.loadLatest();

    if (latestSession) {
      this.snapshot = { ...latestSession, bridgeBaseUrl: this.bridgeBaseUrl };
    }

    this.handlers.onSnapshot(this.snapshot, this.connection);
  }

  connect(): void {
    this.bridgeClient?.disconnect();
    this.bridgeClient = new HttpSseBridgeClient(this.bridgeBaseUrl, this.snapshot.sessionId, {
      onConnectionChange: (connection) => {
        this.connection = connection;
        this.handlers.onConnection(connection);
      },
      onEvent: (event) => void this.applyBridgeEvent(event),
      onError: (message) => this.handlers.onError(message)
    });
    this.bridgeClient.connect();
  }

  dispose(): void {
    this.bridgeClient?.disconnect();

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      void this.store.save(this.snapshot).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.handlers.onError(`Failed to save Megaplan session: ${message}`);
      });
    }
  }

  async sendHumanCommand(command: Omit<HumanCommand, 'commandId' | 'sessionId' | 'timestamp'>): Promise<void> {
    if (!this.bridgeClient) {
      this.connect();
    }

    const humanCommand = {
      ...command,
      commandId: randomId('cmd'),
      sessionId: this.snapshot.sessionId,
      timestamp: new Date().toISOString()
    } as HumanCommand;

    if (humanCommand.type === 'startTask' && !humanCommand.workspaceRoot) {
      humanCommand.workspaceRoot = this.workspaceRoot;
    }

    try {
      await this.bridgeClient?.sendCommand(humanCommand);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(message);
      this.handlers.onError(message);
    }
  }

  getSnapshot(): MegaplanGraphSnapshot {
    return this.snapshot;
  }

  getConnection(): BridgeConnectionState {
    return this.connection;
  }

  private async applyBridgeEvent(event: BridgeEvent): Promise<void> {
    try {
      this.snapshot = reduceBridgeEvent(this.snapshot, event);
      this.handlers.onEvent(event, this.snapshot);
      this.queueSave();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handlers.onError(message);
    }
  }

  private queueSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.store.save(this.snapshot).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.handlers.onError(`Failed to save Megaplan session: ${message}`);
      });
    }, 250);
  }
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
