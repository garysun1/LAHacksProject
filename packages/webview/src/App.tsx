import { useCallback, useEffect, useMemo, useState } from 'react';
import { createEmptySnapshot, getDownstreamNodeIds, getGraphBreadcrumbs, getGraphEdges, getGraphNodes, type BridgeConnectionState, type HumanCommand, type MegaplanGraphSnapshot } from '@megaplan/shared';
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
  const focusedGraphId = snapshot.focusedGraphId ?? snapshot.rootGraphId ?? 'root';
  const focusedNodes = useMemo(() => getGraphNodes(focusedGraphId, snapshot.nodes), [focusedGraphId, snapshot.nodes]);
  const focusedEdges = useMemo(() => getGraphEdges(focusedGraphId, snapshot.nodes, snapshot.edges), [focusedGraphId, snapshot.nodes, snapshot.edges]);
  const focusedSnapshot = useMemo<MegaplanGraphSnapshot>(() => ({
    ...snapshot,
    nodes: focusedNodes,
    edges: focusedEdges
  }), [focusedEdges, focusedNodes, snapshot]);
  const breadcrumbs = useMemo(() => getGraphBreadcrumbs(focusedGraphId, snapshot.graphs, snapshot.nodes), [focusedGraphId, snapshot.graphs, snapshot.nodes]);
  const focusedGraph = useMemo(() => snapshot.graphs?.find((graph) => graph.id === focusedGraphId), [focusedGraphId, snapshot.graphs]);

  const impactedNodeIds = useMemo(() => selectedNodeId ? getDownstreamNodeIds(selectedNodeId, focusedEdges) : [], [selectedNodeId, focusedEdges]);

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
        <PhaseCard label="Planning" count={focusedNodes.filter((node) => node.phase === 'planning').length} />
        <PhaseCard label="Execution" count={focusedNodes.filter((node) => node.phase === 'execution').length} />
        <PhaseCard label="Review" count={focusedNodes.filter((node) => node.phase === 'review').length} />
        <RipplePanel impactedNodeIds={impactedNodeIds} />
      </section>

      <section className="graph-nav">
        <div className="breadcrumbs">
          {breadcrumbs.map((graph, index) => (
            <button type="button" key={graph.id} className={graph.id === focusedGraphId ? 'active' : ''} onClick={() => sendCommand({ type: 'focusGraph', graphId: graph.id })}>
              {index > 0 ? '› ' : ''}{graph.title}
            </button>
          ))}
        </div>
        <div className="graph-actions">
          <span>{focusedGraph?.status ?? 'idle'}</span>
          <button type="button" onClick={() => sendCommand({ type: 'runGraph', graphId: focusedGraphId })}>Run graph</button>
        </div>
      </section>

      <section className="workspace">
        <div className="graph-panel">
          <MegaplanGraph
            snapshot={focusedSnapshot}
            selectedNodeId={selectedNodeId}
            impactedNodeIds={impactedNodeIds}
            onSelectNode={setSelectedNodeId}
            onExpandNode={(nodeId) => sendCommand({ type: 'decomposeNode', nodeId })}
            onFocusGraph={(graphId) => sendCommand({ type: 'focusGraph', graphId })}
          />
        </div>
        <NodeInspector node={selectedNode} graphs={snapshot.graphs ?? []} toolUses={snapshot.pendingToolUses ?? []} onCommand={sendCommand} />
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
