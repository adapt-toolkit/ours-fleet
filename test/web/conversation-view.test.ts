import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ToolContent, ToolLocation } from '../../web/src/ConversationView.js';

describe('conversation provenance rendering', () => {
  it('renders every bounded diff provenance field for both changed sides', () => {
    const html = renderToStaticMarkup(createElement(ToolContent, { content: {
      type: 'diff', path: 'WORKLOG.md', operation: 'edit', bounded: true,
      beforeBytes: 900_000, afterBytes: 800_000,
      commonPrefixBytes: 700_000, commonSuffixBytes: 42,
      oldText: {
        text: 'old tail', bytes: 100_000, truncated: true,
        omittedPrefixBytes: 34_464, startsMidLine: true, digest: 'old-digest',
      },
      newText: {
        text: 'new tail', bytes: 90_000, truncated: true,
        omittedPrefixBytes: 24_464, digest: 'new-digest',
      },
    } }));
    expect(html).toContain('700000 unchanged prefix bytes omitted');
    expect(html).toContain('42 unchanged suffix bytes omitted');
    expect(html).toContain('Prior side');
    expect(html).toContain('100000 bytes');
    expect(html).toContain('34464 leading bytes omitted');
    expect(html).toContain('retained tail starts mid-line');
    expect(html).toContain('digest old-digest');
    expect(html).toContain('Current side');
    expect(html).toContain('digest new-digest');
  });

  it('renders digest and omitted-prefix provenance for truncated tool locations', () => {
    const html = renderToStaticMarkup(createElement(ToolLocation, { location: {
      path: '/tail/file.ts', line: 7, pathBytes: 9_000, pathTruncated: true,
      pathOmittedPrefixBytes: 4_904, pathDigest: 'path-digest',
    } }));
    expect(html).toContain('/tail/file.ts:7');
    expect(html).toContain('9000 bytes total');
    expect(html).toContain('4904 leading bytes omitted');
    expect(html).toContain('digest path-digest');
  });
});
