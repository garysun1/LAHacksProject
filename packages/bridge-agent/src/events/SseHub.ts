import type { Response } from 'express';
import type { BridgeEvent } from '@megaplan/shared';

export class SseHub {
  private readonly clients = new Map<string, Set<Response>>();

  connect(sessionId: string, response: Response): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write(': connected\n\n');

    const sessionClients = this.clients.get(sessionId) ?? new Set<Response>();
    sessionClients.add(response);
    this.clients.set(sessionId, sessionClients);

    response.on('close', () => {
      sessionClients.delete(response);

      if (sessionClients.size === 0) {
        this.clients.delete(sessionId);
      }
    });
  }

  publish(event: BridgeEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    for (const client of this.clients.get(event.sessionId) ?? []) {
      client.write(payload);
    }
  }
}
