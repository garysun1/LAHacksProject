import type { HumanCommand } from '@megaplan/shared';
import { OpenAiAgent } from '../openai/OpenAiAgent';
import type { SseHub } from '../events/SseHub';
import { AgentSession } from './AgentSession';

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly agent = new OpenAiAgent();

  constructor(private readonly sseHub: SseHub) {}

  getSession(sessionId: string): AgentSession {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = new AgentSession(sessionId, this.agent, (event) => this.sseHub.publish(event));
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  async handleCommand(command: HumanCommand): Promise<void> {
    await this.getSession(command.sessionId).handleCommand(command);
  }

  openAiConfigured(): boolean {
    return this.agent.configured;
  }
}
