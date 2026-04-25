# Megaplan

Megaplan is a VS Code extension prototype that replaces the chat sidebar with a living graph surface for agent planning, execution, approval, and review.

## What this repo contains

- **`packages/extension`**: VS Code extension host that opens the Megaplan Webview Panel, persists sessions, and connects to the local bridge-agent.
- **`packages/webview`**: Vite/React/React Flow UI rendered inside the VS Code webview.
- **`packages/shared`**: Shared graph schemas, bridge contracts, reducer logic, and graph utilities.
- **`packages/bridge-agent`**: Local Node/Express bridge-agent that calls OpenAI `gpt-4o`, emits SSE graph events, and executes approval-gated workspace tools.

## Prerequisites

- Node.js 20+
- npm 10+
- VS Code
- Optional `OPENAI_API_KEY` in your shell environment for model-backed planning and execution

## Setup

```bash
npm install
```

## Validation

```bash
npm run typecheck
npm test
npm run compile
```

The root validation covers the shared reducer/schema package, webview typechecking, extension host typechecking and persistence tests, and bridge-agent session/tool-policy tests.

## Bridge-agent

Start the local bridge-agent:

```bash
npm run bridge
```

With `OPENAI_API_KEY` set, the bridge-agent uses `gpt-4o` for planning, lazy decomposition, and execution reasoning:

```bash
OPENAI_API_KEY=... npm run bridge
```

Without `OPENAI_API_KEY`, the bridge still starts and uses deterministic fallback graph/execution behavior so local validation and extension demos can run without external API calls.

Optional environment variables:

- **`MEGAPLAN_BRIDGE_HOST`**: defaults to `127.0.0.1`.
- **`MEGAPLAN_BRIDGE_PORT`**: defaults to `37241`.

## Launch the extension

1. Run `npm run compile`.
2. Start the bridge-agent with `npm run bridge`.
3. Open this folder in VS Code.
4. Press `F5` and choose `Run Megaplan Extension`; the Extension Development Host opens `test-workspace` so it has a real workspace folder without reusing the source window.
5. In the Extension Development Host, run `Megaplan: Open Panel` from the Command Palette.
6. Submit a task in the Megaplan panel.

Sessions are persisted under `.megaplan/sessions/{sessionId}.json` in the workspace. The extension restores a configured session when `megaplan.sessionId` is set; otherwise it restores the latest valid persisted session if one exists.

## VS Code settings

- **`megaplan.bridgeBaseUrl`**: defaults to `http://127.0.0.1:37241`.
- **`megaplan.sessionId`**: optional fixed session ID.
- **`megaplan.autoConnect`**: defaults to `true`.

## Bridge contract

The extension connects to the local bridge-agent at `http://127.0.0.1:37241` by default.

- **Health:** `GET /health`
- **Events:** `GET /events?sessionId={sessionId}`
- **Commands:** `POST /commands`

The webview sends human steering commands through the extension host; the bridge-agent returns graph updates as SSE events. Commands and events are validated with shared Zod schemas.

### Events

- `sessionSnapshot`
- `nodesAdded`
- `nodesUpdated`
- `edgesUpdated`
- `activeNodeChanged`
- `nodeInvalidated`
- `alternativesProposed`
- `approvalRequested`
- `toolUseUpdated`
- `artifactLinked`
- `agentError`

### Commands

- `startTask`
- `decomposeNode`
- `reorderNodes`
- `deleteNode`
- `pinNode`
- `selectAlternative`
- `approveNode`
- `rejectNode`
- `approveToolUse`
- `rejectToolUse`
- `requestReplan`

## Manual smoke test

1. Run `npm run typecheck && npm test && npm run compile`.
2. Run `npm run bridge`.
3. Open the extension development host with `F5`.
4. Run `Megaplan: Open Panel`.
5. Submit a task and confirm a graph snapshot renders.
6. Expand a node and confirm child nodes are added.
7. If a patch approval appears, approve or reject it and confirm the approval status updates in the inspector.
8. Close and reopen the panel and confirm the latest valid session is restored.

## Current prototype limitations

- The first prototype is single-user and local-only.
- The bridge-agent fallback path is intentionally simple when no OpenAI key is configured.
- Risky file writes are approval-gated; unrestricted command execution is not supported.
- Graph layout is intentionally lightweight and uses simple React Flow positioning.
