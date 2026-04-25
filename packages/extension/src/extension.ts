import * as vscode from 'vscode';
import { MegaplanPanel } from './MegaplanPanel';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('megaplan.openPanel', () => {
    MegaplanPanel.createOrShow(context);
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  MegaplanPanel.currentPanel?.dispose();
}
