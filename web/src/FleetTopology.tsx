import { layoutTopology, nodeDestination, type Topology, type TopologyNode } from './topology-presentation';

export function FleetTopology({ topology, onAgent, onWatchdog }: {
  topology: Topology;
  onAgent(id: string): void;
  onWatchdog(id: string): void;
}) {
  const layout = layoutTopology(topology);
  const byId = new Map(layout.nodes.map(node => [node.id, node]));
  const activate = (node: TopologyNode) => {
    const destination = nodeDestination(node);
    if (destination?.kind === 'agent') onAgent(destination.id);
    if (destination?.kind === 'watchdog') onWatchdog(destination.id);
  };
  return <>
    <div className="topology" aria-label="Interactive fleet topology">
      <div className="topology-canvas" style={{ height: layout.height }}>
        <svg aria-hidden="true" viewBox={`0 0 1000 ${layout.height}`} preserveAspectRatio="none">
          {topology.edges.map(edge => {
            const from = byId.get(edge.from); const to = byId.get(edge.to);
            return from && to ? <g key={edge.id} className={`edge ${edge.kind}`}>
              <line x1={from.x + 75} y1={from.y + 30} x2={to.x + 75} y2={to.y + 30} />
              <title>{edge.label}</title>
            </g> : null;
          })}
        </svg>
        {layout.nodes.map(node => <button key={node.id}
          className={`topology-node ${node.kind} ${node.status} ${node.lifetime ?? ''}`}
          style={{ left: node.x, top: node.y }} onClick={() => activate(node)}
          disabled={!nodeDestination(node)} aria-label={`${node.kind} ${node.label}, ${node.status}`}>
          <small>{node.kind}{node.lifetime ? ` · ${node.lifetime}` : ''}</small>
          <strong>{node.label}</strong><span>{node.detail || node.status}</span>
        </button>)}
      </div>
    </div>
    {topology.unknownLineage.length > 0 && <p className="lineage-note">
      Spawn parent unavailable for: {topology.unknownLineage.join(', ')}. No lineage was inferred.
    </p>}
    <details className="topology-fallback">
      <summary>Accessible list view</summary>
      <table><thead><tr><th>Type</th><th>Name</th><th>Status</th><th>Connections</th></tr></thead>
        <tbody>{topology.nodes.map(node => <tr key={node.id}>
          <td>{node.kind}</td><td>{nodeDestination(node)
            ? <button className="text-button" onClick={() => activate(node)}>{node.label}</button>
            : node.label}</td><td>{node.status}</td>
          <td>{topology.edges.filter(edge => edge.from === node.id || edge.to === node.id)
            .map(edge => edge.label).join(', ') || '—'}</td>
        </tr>)}</tbody></table>
      </details>
  </>;
}
