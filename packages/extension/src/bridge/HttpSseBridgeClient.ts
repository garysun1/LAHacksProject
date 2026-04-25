import { bridgeEventSchema, humanCommandSchema, type BridgeConnectionState, type BridgeEvent, type HumanCommand } from '@megaplan/shared';

export type BridgeClientHandlers = {
  onConnectionChange: (connection: BridgeConnectionState) => void;
  onEvent: (event: BridgeEvent) => void;
  onError: (message: string) => void;
};

export class HttpSseBridgeClient {
  private abortController?: AbortController;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly bridgeBaseUrl: string,
    private readonly sessionId: string,
    private readonly handlers: BridgeClientHandlers
  ) {}

  connect(): void {
    this.disconnect();
    this.handlers.onConnectionChange({ status: 'connecting', bridgeBaseUrl: this.bridgeBaseUrl });
    void this.readEventStream();
  }

  disconnect(): void {
    this.abortController?.abort();
    this.abortController = undefined;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  async sendCommand(command: HumanCommand): Promise<void> {
    humanCommandSchema.parse(command);

    const response = await fetch(`${this.bridgeBaseUrl}/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Bridge command failed: ${response.status} ${text}`);
    }
  }

  private async readEventStream(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const url = `${this.bridgeBaseUrl}/events?sessionId=${encodeURIComponent(this.sessionId)}`;
      const response = await fetch(url, {
        headers: {
          Accept: 'text/event-stream'
        },
        signal: abortController.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(`Bridge events failed: ${response.status} ${response.statusText}`);
      }

      this.handlers.onConnectionChange({ status: 'connected', bridgeBaseUrl: this.bridgeBaseUrl });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!abortController.signal.aborted) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          this.consumeSseMessage(message);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.handlers.onConnectionChange({ status: 'error', bridgeBaseUrl: this.bridgeBaseUrl, message });
        this.handlers.onError(message);
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    }
  }

  private consumeSseMessage(message: string): void {
    const dataLines = message
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());

    if (dataLines.length === 0) {
      return;
    }

    try {
      const parsed = JSON.parse(dataLines.join('\n'));
      const event = bridgeEventSchema.parse(parsed) as BridgeEvent;
      this.handlers.onEvent(event);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      this.handlers.onError(`Malformed bridge event: ${details}`);
    }
  }
}
