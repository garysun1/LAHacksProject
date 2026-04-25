import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@megaplan/shared';

type VsCodeApi = {
  postMessage: (message: WebviewToExtensionMessage) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

declare const acquireVsCodeApi: undefined | (() => VsCodeApi);

const fallbackApi: VsCodeApi = {
  postMessage: (message) => console.log('VS Code API unavailable', message),
  getState: () => undefined,
  setState: () => undefined
};

export const vscodeApi: VsCodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : fallbackApi;

export function postMessage(message: WebviewToExtensionMessage): void {
  vscodeApi.postMessage(message);
}

export function listenForMessages(handler: (message: ExtensionToWebviewMessage) => void): () => void {
  const listener = (event: MessageEvent<ExtensionToWebviewMessage>) => handler(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
