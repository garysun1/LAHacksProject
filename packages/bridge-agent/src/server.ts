import cors from 'cors';
import express from 'express';
import { SseHub } from './events/SseHub';
import { loadProjectEnv } from './env';
import { createCommandsRouter } from './routes/commands';
import { createEventsRouter } from './routes/events';
import { SessionManager } from './session/SessionManager';

loadProjectEnv();

const port = Number(process.env.MEGAPLAN_BRIDGE_PORT ?? 37241);
const host = process.env.MEGAPLAN_BRIDGE_HOST ?? '127.0.0.1';

const app = express();
const sseHub = new SseHub();
const sessionManager = new SessionManager(sseHub);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    openAiConfigured: sessionManager.openAiConfigured(),
    model: 'gpt-4o'
  });
});

app.use('/events', createEventsRouter(sseHub, sessionManager));
app.use('/commands', createCommandsRouter(sessionManager));

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  response.status(400).json({ ok: false, error: message });
});

app.listen(port, host, () => {
  const apiStatus = process.env.OPENAI_API_KEY ? 'configured' : 'missing OPENAI_API_KEY; fallback graph mode enabled';
  console.log(`Megaplan bridge-agent listening at http://${host}:${port} (${apiStatus})`);
});
