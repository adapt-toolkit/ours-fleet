export interface MetadataItem { label: string; value: string }

const reportedSelector = (selector: { value?: string; label?: string } | undefined): string => {
  if (!selector?.value) return 'Not reported';
  return selector.label && selector.label !== selector.value
    ? `${selector.label} · ${selector.value}` : selector.value;
};

/** Compact, honest runtime facts. Live ACP values win; creation defaults are never inferred. */
export function runtimeMetadata(detail: any): MetadataItem[] {
  const config = detail?.role?.config;
  const session = detail?.status?.session;
  const permission = session?.permissionMode;
  return [
    { label: 'Harness', value: config?.harness ?? 'Unavailable' },
    { label: 'Model', value: reportedSelector(session?.runtimeModel) },
    { label: 'Reasoning', value: reportedSelector(session?.reasoningEffort) },
    { label: 'Permission', value: permission?.fleetMode ?? 'Not reported' },
    { label: 'Native mode', value: permission?.nativeMode ?? 'Not reported' },
    { label: 'Filesystem', value: config?.permissions?.filesystem ?? 'Unavailable' },
    { label: 'Backend', value: session?.backend ?? 'Unavailable' },
    { label: 'Protocol', value: session?.protocolVersion
      ? `ACP v${session.protocolVersion}${session.features?.length ? ` · ${session.features.join(', ')}` : ''}`
      : 'Not reported' },
  ];
}
