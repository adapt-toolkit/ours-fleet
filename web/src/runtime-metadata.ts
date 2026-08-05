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
  const native = config?.nativeRuntime;
  return [
    { label: 'Harness', value: config?.harness ?? 'Unavailable' },
    { label: 'Model', value: reportedSelector(session?.runtimeModel) },
    { label: 'Reasoning', value: reportedSelector(session?.reasoningEffort) },
    { label: 'Approval', value: native?.approval ?? config?.permissions?.approval ?? 'Unavailable' },
    { label: 'Permission', value: native?.permissionMode ?? 'Not reported' },
    { label: 'Filesystem', value: config?.permissions?.filesystem ?? 'Unavailable' },
    { label: 'Sandbox', value: native?.sandbox ?? 'Not reported' },
    { label: 'Backend', value: session?.backend ?? 'Unavailable' },
    { label: 'Protocol', value: session?.protocolVersion
      ? `ACP v${session.protocolVersion}${session.features?.length ? ` · ${session.features.join(', ')}` : ''}`
      : 'Not reported' },
  ];
}
