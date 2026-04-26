import type { BridgeEvent, MegaplanGraphSnapshot, ToolUseRequest } from '@megaplan/shared';

type Props = {
  snapshot: MegaplanGraphSnapshot;
};

type TimelineItem = {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  timestamp: string;
  tone: 'default' | 'active' | 'success' | 'warning' | 'danger';
};

export function EventTimeline({ snapshot }: Props): JSX.Element {
  const events = (snapshot.eventLog ?? []).map((event) => describeEvent(event, snapshot)).filter((item): item is TimelineItem => Boolean(item)).slice(-40).reverse();

  return (
    <section className="event-timeline" aria-label="Event timeline">
      <div className="timeline-header">
        <div>
          <h2>Timeline</h2>
          <p>Recent agent activity</p>
        </div>
        <span>{events.length}</span>
      </div>
      {events.length ? (
        <ol className="timeline-list">
          {events.map((item) => (
            <li className={`timeline-item tone-${item.tone}`} key={item.id}>
              <div className="timeline-dot" />
              <div className="timeline-copy">
                <div className="timeline-meta">
                  <span>{item.kind}</span>
                  <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
                </div>
                <strong>{item.title}</strong>
                {item.detail ? <p>{item.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="timeline-empty">Constructed subgraphs, completed nodes, selected alternatives, approved tools, and deleted nodes will appear here.</div>
      )}
    </section>
  );
}

function describeEvent(event: BridgeEvent, snapshot: MegaplanGraphSnapshot): TimelineItem | undefined {
  const base = {
    id: event.eventId,
    timestamp: event.timestamp
  };

  switch (event.type) {
    case 'sessionSnapshot':
      return undefined;
    case 'nodesAdded':
      return undefined;
    case 'nodesUpdated':
      return describeNodeUpdate(event, snapshot, base);
    case 'edgesUpdated':
      return undefined;
    case 'graphsUpdated':
      return undefined;
    case 'activeNodeChanged':
      return undefined;
    case 'graphFocused':
      return undefined;
    case 'graphRunStateChanged':
      return describeGraphRunState(event, snapshot, base);
    case 'nodeInvalidated': {
      return event.reason === 'Deleted by user.'
        ? { ...base, kind: 'Delete', title: `Deleted ${nodeTitle(snapshot, event.nodeId)}`, tone: 'danger' }
        : undefined;
    }
    case 'alternativesProposed':
      return undefined;
    case 'approvalRequested':
      return undefined;
    case 'toolUseUpdated': {
      return event.patch.status === 'approved'
        ? { ...base, kind: 'Approval', title: `Approved ${toolUseTitle(snapshot.pendingToolUses ?? [], event.toolUseId)}`, tone: 'success' }
        : undefined;
    }
    case 'artifactLinked':
      return undefined;
    case 'agentError':
      return undefined;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function describeGraphRunState(
  event: Extract<BridgeEvent, { type: 'graphRunStateChanged' }>,
  snapshot: MegaplanGraphSnapshot,
  base: Pick<TimelineItem, 'id' | 'timestamp'>
): TimelineItem | undefined {
  if (event.message !== 'Constructed subgraph.') {
    return undefined;
  }

  const graph = snapshot.graphs?.find((candidate) => candidate.id === event.graphId);

  if (!graph?.parentNodeId) {
    return undefined;
  }

  return {
    ...base,
    kind: 'Construct',
    title: `Constructed subgraph for ${nodeTitle(snapshot, graph.parentNodeId)}`,
    detail: graph.title,
    tone: 'success'
  };
}

function describeNodeUpdate(
  event: Extract<BridgeEvent, { type: 'nodesUpdated' }>,
  snapshot: MegaplanGraphSnapshot,
  base: Pick<TimelineItem, 'id' | 'timestamp'>
): TimelineItem | undefined {
  const alternativePatch = event.patches.find((patch) => patch.patch.selectedAlternativeId);

  if (alternativePatch) {
    return {
      ...base,
      kind: 'Decision',
      title: `Selected alternative for ${nodeTitle(snapshot, alternativePatch.id)}`,
      detail: alternativePatch.patch.title,
      tone: 'active'
    };
  }

  const completedPatch = event.patches.find((patch) => patch.patch.status === 'completed');

  if (completedPatch) {
    return {
      ...base,
      kind: 'Run',
      title: `Finished ${nodeTitle(snapshot, completedPatch.id)}`,
      tone: 'success'
    };
  }

  return undefined;
}

function nodeTitle(snapshot: MegaplanGraphSnapshot, nodeId: string): string {
  return snapshot.nodes.find((node) => node.id === nodeId)?.title ?? nodeId;
}

function toolUseTitle(toolUses: ToolUseRequest[], toolUseId: string): string {
  return toolUses.find((toolUse) => toolUse.id === toolUseId)?.title ?? 'Tool use';
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
