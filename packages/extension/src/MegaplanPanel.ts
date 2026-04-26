import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BridgeConnectionState, ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@megaplan/shared';
import { GraphController } from './graph/GraphController';
import { SessionStore } from './storage/SessionStore';

export class MegaplanPanel {
  static currentPanel: MegaplanPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private controller?: GraphController;
  private lastConnection: BridgeConnectionState = {
    status: 'disconnected',
    bridgeBaseUrl: 'http://127.0.0.1:37241'
  };

  static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (MegaplanPanel.currentPanel) {
      MegaplanPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'megaplan.panel',
      'Megaplan',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'packages', 'webview', 'dist')
        ]
      }
    );

    MegaplanPanel.currentPanel = new MegaplanPanel(context, panel);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel
  ) {
    this.panel.webview.html = this.getHtmlForWebview();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      void this.handleWebviewMessage(message);
    }, null, this.disposables);

    void this.initializeController();
  }

  dispose(): void {
    MegaplanPanel.currentPanel = undefined;
    this.controller?.dispose();

    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private async initializeController(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const configuration = vscode.workspace.getConfiguration('megaplan');
    const bridgeBaseUrl = configuration.get<string>('bridgeBaseUrl') ?? 'http://127.0.0.1:37241';
    this.lastConnection = { status: 'disconnected', bridgeBaseUrl };

    if (!workspaceRoot) {
      this.lastConnection = {
        status: 'error',
        bridgeBaseUrl,
        message: 'Megaplan requires an open workspace folder.'
      };
      this.postMessage({ type: 'connection', connection: this.lastConnection });
      this.postMessage({ type: 'error', message: 'Megaplan requires an open workspace folder.' });
      return;
    }

    const configuredSessionId = configuration.get<string>('sessionId')?.trim();
    const sessionId = configuredSessionId || randomId('session');
    const autoConnect = configuration.get<boolean>('autoConnect') ?? true;
    const restoreConfiguredSession = Boolean(configuredSessionId);

    this.controller = new GraphController(
      workspaceRoot,
      new SessionStore(workspaceRoot),
      {
        onSnapshot: (snapshot, connection) => this.postMessage({ type: 'state', snapshot, connection }),
        onEvent: (event, snapshot) => this.postMessage({ type: 'event', event, snapshot }),
        onConnection: (connection) => {
          this.lastConnection = connection;
          this.postMessage({ type: 'connection', connection });
        },
        onError: (message) => this.postMessage({ type: 'error', message })
      },
      bridgeBaseUrl,
      sessionId,
      restoreConfiguredSession
    );

    await this.controller.initialize();

    if (autoConnect) {
      this.controller.connect();
    }
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    if (message.type === 'ready') {
      const snapshot = this.controller?.getSnapshot();

      if (snapshot) {
        this.postMessage({
          type: 'state',
          snapshot,
          connection: this.controller?.getConnection() ?? this.lastConnection
        });
      } else {
        this.postMessage({ type: 'connection', connection: this.lastConnection });
      }

      return;
    }

    if (message.type === 'connect') {
      if (!this.controller) {
        this.postMessage({ type: 'connection', connection: this.lastConnection });
        this.postMessage({ type: 'error', message: this.lastConnection.message ?? 'Megaplan requires an open workspace folder before connecting.' });
        return;
      }

      this.controller?.connect();
      return;
    }

    if (message.type === 'command') {
      if (!this.controller) {
        this.postMessage({ type: 'connection', connection: this.lastConnection });
        this.postMessage({ type: 'error', message: this.lastConnection.message ?? 'Megaplan requires an open workspace folder before running tasks.' });
        return;
      }

      await this.controller.sendHumanCommand(message.command);
    }
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtmlForWebview(): string {
    const webview = this.panel.webview;
    const distPath = vscode.Uri.joinPath(this.context.extensionUri, 'packages', 'webview', 'dist');
    const assetsPath = vscode.Uri.joinPath(distPath, 'assets');
    const nonce = randomId('nonce');
    const cspSource = webview.cspSource;

    const assetFiles = fs.existsSync(assetsPath.fsPath) ? fs.readdirSync(assetsPath.fsPath) : [];
    const scriptFile = assetFiles.find((file) => file.endsWith('.js'));
    const styleFile = assetFiles.find((file) => file.endsWith('.css'));

    const scriptUri = scriptFile ? webview.asWebviewUri(vscode.Uri.file(path.join(assetsPath.fsPath, scriptFile))) : undefined;
    const styleUri = styleFile ? webview.asWebviewUri(vscode.Uri.file(path.join(assetsPath.fsPath, styleFile))) : undefined;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
  ${styleUri ? `<link rel="stylesheet" href="${styleUri.toString()}">` : ''}
  <title>Megaplan</title>
</head>
<body>
  <div id="root">Megaplan webview assets have not been built yet. Run <code>npm run build:webview</code>.</div>
  ${scriptUri ? `<script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>` : ''}
</body>
</html>`;
  }
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
