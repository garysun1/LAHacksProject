import { Router } from 'express';
import type { SseHub } from '../events/SseHub';
import type { SessionManager } from '../session/SessionManager';

export function createEventsRouter(sseHub: SseHub, sessionManager: SessionManager): Router {
  const router = Router();

  router.get('/', (request, response) => {
    const sessionId = typeof request.query.sessionId === 'string' && request.query.sessionId.trim()
      ? request.query.sessionId.trim()
      : 'default-session';

    sessionManager.getSession(sessionId);
    sseHub.connect(sessionId, response);
  });

  return router;
}
