import type { DocsService } from '@affine/core/modules/doc';
import type { DocsSearchService } from '@affine/core/modules/docs-search';
import type { BlockModel, Store } from '@blocksuite/affine/store';
import { firstValueFrom, timeout } from 'rxjs';

import type { LocalWorkspaceContent } from './backend';
import {
  appendMarkdown,
  applyTaggedMarkdown,
  exportTaggedMarkdown,
} from './doc-tools';

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

/** Downscales an image to at most 1024px and returns a JPEG/PNG data URL. */
async function imageToDataUrl(data: Uint8Array, mime?: string) {
  const blob = new Blob([data as BlobPart], { type: mime || 'image/png' });
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    );
    canvas
      .getContext('2d')
      ?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const out = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: 0.85,
    });
    return await blobToDataUrl(out);
  } catch {
    // e.g. SVG: send as-is
    return await blobToDataUrl(blob);
  }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function createLocalWorkspaceContent(
  docsService: DocsService,
  docsSearchService: DocsSearchService,
  getBlob?: (
    blobId: string
  ) => Promise<{ data: Uint8Array; mime?: string } | null | undefined>
): LocalWorkspaceContent {
  /** opens a live (non-trashed) doc, loaded and ready to edit */
  const withDoc = async <T>(
    docId: string,
    fn: (doc: ReturnType<DocsService['open']>['doc']) => Promise<T>
  ): Promise<T | null> => {
    const record = docsService.list.doc$(docId).value;
    if (!record || record.trash$.value) return null;
    const { doc, release } = docsService.open(docId);
    try {
      const disposePriority = doc.addPriorityLoad(10);
      await doc.waitForSyncReady();
      disposePriority();
      return await fn(doc);
    } finally {
      release();
    }
  };

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
      return withDoc(docId, async doc => {
        const store = doc.blockSuiteDoc;
        const exported = await exportTaggedMarkdown(store).catch(() => null);
        return {
          docId,
          title: doc.title$.value || 'Untitled',
          markdown: exported?.markdown || storeToMarkdown(store),
          images: exported?.images ?? [],
        };
      });
    },
    async createDoc(title, markdown) {
      const record = docsService.createDoc({ title, primaryMode: 'page' });
      const inserted = await withDoc(record.id, doc =>
        appendMarkdown(doc.blockSuiteDoc, markdown)
      );
      return { docId: record.id, title, blocks: inserted ?? 0 };
    },
    async editDoc(docId, markdown) {
      return withDoc(docId, doc =>
        applyTaggedMarkdown(doc.blockSuiteDoc, markdown)
      );
    },
    async appendToDoc(docId, markdown, afterBlockId) {
      const inserted = await withDoc(docId, doc =>
        appendMarkdown(doc.blockSuiteDoc, markdown, afterBlockId)
      );
      return inserted === null ? null : { inserted };
    },
    async renameDoc(docId, title) {
      const record = docsService.list.doc$(docId).value;
      if (!record || record.trash$.value) return false;
      await docsService.changeDocTitle(docId, title);
      return true;
    },
    async getImage(blobId) {
      const record = await getBlob?.(blobId);
      if (!record) return null;
      return imageToDataUrl(record.data, record.mime);
    },
  };
}
