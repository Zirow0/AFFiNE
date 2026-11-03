import type { DocsService } from '@affine/core/modules/doc';
import type { DocsSearchService } from '@affine/core/modules/docs-search';
import type { BlockModel, Store } from '@blocksuite/affine/store';
import { firstValueFrom, timeout } from 'rxjs';

import type { LocalWorkspaceContent } from './backend';

/**
 * Plain Markdown serialization of a doc's blocks. Deliberately simple and
 * independent of an editor instance, so it works for docs that are not open.
 */
function textOf(model: BlockModel) {
  const text = (model.props as { text?: { toString(): string } }).text;
  return text ? text.toString() : '';
}

function serializeBlock(model: BlockModel, depth: number, out: string[]) {
  const props = model.props as Record<string, any>;
  const indent = '  '.repeat(depth);
  const text = textOf(model);
  let childDepth = depth;
  switch (model.flavour) {
    case 'affine:page':
    case 'affine:note':
    case 'affine:surface':
      childDepth = depth;
      break;
    case 'affine:paragraph': {
      const type = props.type as string | undefined;
      if (type && /^h[1-6]$/.test(type)) {
        out.push(`${'#'.repeat(Number(type[1]))} ${text}`);
      } else if (type === 'quote') {
        out.push(`> ${text}`);
      } else if (text) {
        out.push(`${indent}${text}`);
      }
      childDepth = depth + 1;
      break;
    }
    case 'affine:list': {
      const type = props.type as string | undefined;
      const marker =
        type === 'numbered'
          ? '1.'
          : type === 'todo'
            ? props.checked
              ? '- [x]'
              : '- [ ]'
            : '-';
      out.push(`${indent}${marker} ${text}`);
      childDepth = depth + 1;
      break;
    }
    case 'affine:code':
      out.push(`\`\`\`${props.language ?? ''}\n${text}\n\`\`\``);
      break;
    case 'affine:divider':
      out.push('---');
      break;
    case 'affine:latex':
      out.push(`$$${props.latex ?? ''}$$`);
      break;
    case 'affine:image':
      out.push(`![${props.caption ?? 'image'}]()`);
      break;
    case 'affine:attachment':
      out.push(`[Attachment: ${props.name ?? 'file'}]`);
      break;
    case 'affine:bookmark':
    case 'affine:embed-youtube':
    case 'affine:embed-figma':
    case 'affine:embed-github':
      if (props.url) out.push(`[${props.title ?? props.url}](${props.url})`);
      break;
    default:
      if (text) out.push(`${indent}${text}`);
      childDepth = depth + 1;
  }
  for (const child of model.children) {
    serializeBlock(child, childDepth, out);
  }
}

export function storeToMarkdown(store: Store) {
  const root = store.root;
  if (!root) return '';
  const out: string[] = [];
  serializeBlock(root, 0, out);
  return out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createLocalWorkspaceContent(
  docsService: DocsService,
  docsSearchService: DocsSearchService
): LocalWorkspaceContent {
  return {
    async searchDocs(query, limit = 10) {
      if (!query.trim()) return [];
      const hits = await firstValueFrom(
        docsSearchService.search$(query, 'local').pipe(timeout(10_000))
      );
      const seen = new Set<string>();
      return hits
        .filter(hit => {
          if (seen.has(hit.docId)) return false;
          seen.add(hit.docId);
          return !docsService.list.doc$(hit.docId).value?.trash$.value;
        })
        .slice(0, limit)
        .map(hit => ({
          docId: hit.docId,
          title: hit.title || 'Untitled',
          excerpt: hit.blockContent,
        }));
    },
    async readDoc(docId) {
      const record = docsService.list.doc$(docId).value;
      if (!record || record.trash$.value) return null;
      const { doc, release } = docsService.open(docId);
      try {
        const disposePriority = doc.addPriorityLoad(10);
        await doc.waitForSyncReady();
        disposePriority();
        return {
          docId,
          title: doc.title$.value || 'Untitled',
          markdown: storeToMarkdown(doc.blockSuiteDoc),
        };
      } finally {
        release();
      }
    },
  };
}
