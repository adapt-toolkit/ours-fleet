import { describeEdge, EDGE_LEGEND, layoutEdges, layoutTopology, nodeDestination, type Topology, type TopologyNode } from './topology-presentation';

export function FleetTopology({ topology, onAgent, onWatchdog, onRemove }: {
  topology: Topology;
  onAgent(id: string): void;
  onWatchdog(id: string): void;
  onRemove?(id: string): void;
}) {
  const layout = layoutTopology(topology);
  const edges = layoutEdges(topology.edges, layout.nodes);
  const activate = (node: TopologyNode) => {
    const destination = nodeDestination(node);
    if (destination?.kind === 'agent') onAgent(destination.id);
    if (destination?.kind === 'watchdog') onWatchdog(destination.id);
  };
  return <>
    <section className="topology-legend" aria-label="Topology connection legend">
      <strong>Connections</strong>
      <ul>{EDGE_LEGEND.map(item => <li key={item.kind} tabIndex={0} aria-label={`${item.label}. ${item.description}`} title={item.description}>
        <span className={`legend-line ${item.kind}`} aria-hidden="true" /><span><b>{item.label}</b><small>{item.description}</small></span>
      </li>)}</ul>
    </section>
    <div className="topology" aria-label="Interactive fleet topology">
      <div className="topology-canvas" style={{ height: layout.height }}>
        {/* No viewBox: the overlay stretches to `.topology-canvas` (min-width:
            100%), so a user-space of its own would rescale the x axis on a wide
            viewport and drag every edge off the cards, which sit in raw CSS px. */}
        <svg aria-hidden="true">
          {edges.map(edge => <g key={edge.id} className={`edge ${edge.kind}`}>
            <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />
            <title>{edge.label}</title>
          </g>)}
        </svg>
        {layout.nodes.map(node => <div key={node.id}
          className={`topology-node ${node.kind} ${node.status} ${node.lifetime ?? ''}`}
          style={{ left: node.x, top: node.y }}>
          <button className="topology-open" onClick={() => activate(node)}
            disabled={!nodeDestination(node)} aria-label={`${node.kind} ${node.label}, ${node.status}`}>
            <small>{node.kind}{node.lifetime ? ` · ${node.lifetime}` : ''}</small>
            <strong>{node.label}</strong><span>{node.detail || node.status}</span>
          </button>
          {node.kind === 'agent' && onRemove && <button className="topology-remove" aria-label={`Remove ${node.label}`} title={`Safely remove ${node.label}`} onClick={() => onRemove(node.label)}>×</button>}
        </div>)}
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
            .map(edge => describeEdge(edge, node.id)).join(' ') || '—'}</td>
        </tr>)}</tbody></table>
      </details>
  </>;
}
