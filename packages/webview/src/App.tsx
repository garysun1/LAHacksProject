import { useCallback, useEffect, useMemo, useState } from 'react';
import { createEmptySnapshot, getDownstreamNodeIds, getGraphBreadcrumbs, getGraphEdges, getGraphNodes, type BridgeConnectionState, type HumanCommand, type MegaplanGraphSnapshot } from '@megaplan/shared';
import { EventTimeline } from './components/EventTimeline';
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

  const focusedGraphId = snapshot.focusedGraphId ?? snapshot.rootGraphId ?? 'root';
  const focusedNodes = useMemo(() => getGraphNodes(focusedGraphId, snapshot.nodes), [focusedGraphId, snapshot.nodes]);
  const focusedEdges = useMemo(() => getGraphEdges(focusedGraphId, snapshot.nodes, snapshot.edges), [focusedGraphId, snapshot.nodes, snapshot.edges]);
  const selectedNode = useMemo(() => focusedNodes.find((node) => node.id === selectedNodeId), [focusedNodes, selectedNodeId]);
  const focusedSnapshot = useMemo<MegaplanGraphSnapshot>(() => ({
    ...snapshot,
    nodes: focusedNodes,
    edges: focusedEdges
  }), [focusedEdges, focusedNodes, snapshot]);
  const breadcrumbs = useMemo(() => getGraphBreadcrumbs(focusedGraphId, snapshot.graphs, snapshot.nodes), [focusedGraphId, snapshot.graphs, snapshot.nodes]);
  const focusedGraph = useMemo(() => snapshot.graphs?.find((graph) => graph.id === focusedGraphId), [focusedGraphId, snapshot.graphs]);

  const impactedNodeIds = useMemo(() => selectedNodeId ? getDownstreamNodeIds(selectedNodeId, focusedEdges) : [], [selectedNodeId, focusedEdges]);

  useEffect(() => {
    if (selectedNodeId && !focusedNodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(undefined);
    }
  }, [focusedNodes, selectedNodeId]);

  useEffect(() => {
    if (snapshot.activeNodeId && focusedNodes.some((node) => node.id === snapshot.activeNodeId)) {
      setSelectedNodeId(snapshot.activeNodeId);
    }
  }, [focusedNodes, snapshot.activeNodeId]);

  const sendCommand = useCallback((command: { type: string; [key: string]: unknown }) => {
    postMessage({ type: 'command', command: command as Omit<HumanCommand, 'commandId' | 'sessionId' | 'timestamp'> });
  }, []);

  const toggleSelectedNode = useCallback((nodeId: string) => {
    setSelectedNodeId((currentNodeId) => currentNodeId === nodeId ? undefined : nodeId);
  }, []);

  const isRootGraph = focusedGraphId === (snapshot.rootGraphId ?? 'root');
  const isFocusedGraphEmpty = focusedNodes.length === 0;

  const performPrimaryAction = useCallback(() => {
    const trimmedInstructions = task.trim();

    if (isFocusedGraphEmpty) {
      if (isRootGraph && !trimmedInstructions) {
        return;
      }

      sendCommand({ type: 'constructGraph', graphId: focusedGraphId, instructions: trimmedInstructions || undefined });
      setTask('');
      return;
    }

    if (selectedNode) {
      sendCommand({ type: 'runNode', nodeId: selectedNode.id });
      return;
    }

    const firstNode = [...focusedNodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];

    if (firstNode) {
      setSelectedNodeId(firstNode.id);
    }

    sendCommand({ type: 'runGraph', graphId: focusedGraphId });
  }, [focusedGraphId, focusedNodes, isFocusedGraphEmpty, isRootGraph, selectedNode, sendCommand, task]);

  const clearFocusedGraph = useCallback(() => {
    if (isFocusedGraphEmpty) {
      return;
    }

    const confirmed = window.confirm(`Clear ${focusedGraph?.title ?? 'the focused graph'}? This removes the current graph pane so you can construct it again.`);

    if (!confirmed) {
      return;
    }

    setSelectedNodeId(undefined);
    setTask('');
    sendCommand({ type: 'clearGraph', graphId: focusedGraphId });
  }, [focusedGraph?.title, focusedGraphId, isFocusedGraphEmpty, sendCommand]);

  const primaryActionLabel = isFocusedGraphEmpty ? 'Construct' : selectedNode ? 'Run node' : 'Run graph';
  const taskPlaceholder = isFocusedGraphEmpty
    ? isRootGraph
      ? 'Describe the task to construct the root graph...'
      : 'Optional context for constructing this subgraph...'
    : selectedNode
      ? `Selected: ${selectedNode.title}`
      : 'Select a node to run it, or run the focused graph.';
  const actionTargetLabel = selectedNode ? `Selected: ${selectedNode.title}` : `Focused graph: ${focusedGraph?.title ?? focusedGraphId}`;
  const primaryActionDisabled = isFocusedGraphEmpty && isRootGraph && !task.trim();
  const emptyGraphMessage = isRootGraph
    ? 'Describe the task below, then construct the root graph.'
    : 'No substeps yet. Add optional context below, then construct this subgraph.';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Omegaplan</h1>
          <p>Planning graph and review.</p>
        </div>
        <div className={`connection status-${connection.status}`}>
          <strong>{connection.status}</strong>
          <span>{connection.bridgeBaseUrl}</span>
          <button type="button" onClick={() => postMessage({ type: 'connect' })}>Connect</button>
        </div>
      </header>

      <div className="error-slot">
        {error ? <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss</button></div> : null}
      </div>

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
          <button type="button" onClick={clearFocusedGraph} disabled={isFocusedGraphEmpty}>Clear</button>
        </div>
      </section>

      <section className="workspace">
        <div className="graph-panel">
          {isFocusedGraphEmpty ? <div className="empty-graph-state">{emptyGraphMessage}</div> : null}
          <MegaplanGraph
            snapshot={focusedSnapshot}
            selectedNodeId={selectedNodeId}
            impactedNodeIds={impactedNodeIds}
            onSelectNode={toggleSelectedNode}
            onOpenNodeGraph={(nodeId) => sendCommand({ type: 'openNodeGraph', nodeId })}
          />
        </div>
        <aside className="side-panel">
          <NodeInspector node={selectedNode} graphs={snapshot.graphs ?? []} toolUses={snapshot.pendingToolUses ?? []} onCommand={sendCommand} />
          <EventTimeline snapshot={snapshot} />
        </aside>
      </section>

      <section className="taskbar">
        <div className="taskbar-context">
          <span>{actionTargetLabel}</span>
          <textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder={taskPlaceholder} disabled={!isFocusedGraphEmpty} />
        </div>
        <button type="button" onClick={performPrimaryAction} disabled={primaryActionDisabled}>{primaryActionLabel}</button>
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
