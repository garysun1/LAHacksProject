import { useCallback, useEffect, useMemo, useState } from 'react';
import { createEmptySnapshot, getDownstreamNodeIds, type BridgeConnectionState, type HumanCommand, type MegaplanGraphSnapshot } from '@megaplan/shared';
import { MegaplanGraph } from './components/MegaplanGraph';
import { NodeInspector } from './components/NodeInspector';
import { RipplePanel } from './components/RipplePanel';
import { listenForMessages, postMessage } from './vscodeApi';

const defaultConnection: BridgeConnectionState = {
  status: 'disconnected',
  bridgeBaseUrl: 'http://127.0.0.1:37241'
};

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<MegaplanGraphSnapshot>(() => createEmptySnapshot('local-preview', defaultConnection.bridgeBaseUrl));
  const [connection, setConnection] = useState<BridgeConnectionState>(defaultConnection);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [task, setTask] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    postMessage({ type: 'ready' });

    return listenForMessages((message) => {
      if (message.type === 'state') {
        setSnapshot(message.snapshot);
        setConnection(message.connection);
      }

      if (message.type === 'event') {
        setSnapshot(message.snapshot);
      }

      if (message.type === 'connection') {
        setConnection(message.connection);
      }

      if (message.type === 'error') {
        setError(message.message);
      }
    });
  }, []);

  const selectedNode = useMemo(() => snapshot.nodes.find((node) => node.id === selectedNodeId), [selectedNodeId, snapshot.nodes]);

  const impactedNodeIds = useMemo(() => selectedNodeId ? getDownstreamNodeIds(selectedNodeId, snapshot.edges) : [], [selectedNodeId, snapshot.edges]);

  const sendCommand = useCallback((command: { type: string; [key: string]: unknown }) => {
    postMessage({ type: 'command', command: command as Omit<HumanCommand, 'commandId' | 'sessionId' | 'timestamp'> });
  }, []);

  const startTask = useCallback(() => {
    const trimmedTask = task.trim();

    if (!trimmedTask) {
      return;
    }

    sendCommand({ type: 'startTask', task: trimmedTask });
    setTask('');
  }, [sendCommand, task]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Megaplan</h1>
          <p>Planning graph and review.</p>
        </div>
        <div className={`connection status-${connection.status}`}>
          <strong>{connection.status}</strong>
          <span>{connection.bridgeBaseUrl}</span>
          <button type="button" onClick={() => postMessage({ type: 'connect' })}>Connect</button>
        </div>
      </header>

      <section className="taskbar">
        <textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder="Describe the coding task for the bridge-agent..." />
        <button type="button" onClick={startTask}>Start task</button>
      </section>

      {error ? <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss</button></div> : null}

      <section className="phase-strip">
        <PhaseCard label="Planning" count={snapshot.nodes.filter((node) => node.phase === 'planning').length} />
        <PhaseCard label="Execution" count={snapshot.nodes.filter((node) => node.phase === 'execution').length} />
        <PhaseCard label="Review" count={snapshot.nodes.filter((node) => node.phase === 'review').length} />
        <RipplePanel impactedNodeIds={impactedNodeIds} />
      </section>

      <section className="workspace">
        <div className="graph-panel">
          <MegaplanGraph
            snapshot={snapshot}
            selectedNodeId={selectedNodeId}
            impactedNodeIds={impactedNodeIds}
            onSelectNode={setSelectedNodeId}
            onExpandNode={(nodeId) => sendCommand({ type: 'decomposeNode', nodeId })}
          />
        </div>
        <NodeInspector node={selectedNode} toolUses={snapshot.pendingToolUses ?? []} onCommand={sendCommand} />
      </section>
    </main>
  );
}

function PhaseCard({ label, count }: { label: string; count: number }): JSX.Element {
  return (
    <div className="phase-card">
      <strong>{label}</strong>
      <span>{count} nodes</span>
    </div>
  );
}
