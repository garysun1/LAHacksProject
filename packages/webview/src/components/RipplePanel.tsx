type Props = {
  impactedNodeIds: string[];
};

export function RipplePanel({ impactedNodeIds }: Props): JSX.Element | null {
  if (impactedNodeIds.length === 0) {
    return null;
  }

  return (
    <div className="ripple-panel">
      <strong>Ripple impact</strong>
      <span>{impactedNodeIds.length} downstream node{impactedNodeIds.length === 1 ? '' : 's'} affected</span>
    </div>
  );
}
