import { Router } from 'express';
import { humanCommandSchema, type HumanCommand } from '@megaplan/shared';
import type { SessionManager } from '../session/SessionManager';

export function createCommandsRouter(sessionManager: SessionManager): Router {
  const router = Router();

  router.post('/', async (request, response, next) => {
    try {
      const command = humanCommandSchema.parse(request.body) as HumanCommand;
      await sessionManager.handleCommand(command);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
