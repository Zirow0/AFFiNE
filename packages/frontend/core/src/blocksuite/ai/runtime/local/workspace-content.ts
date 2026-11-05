import type { DocsService } from '@affine/core/modules/doc';
import type { DocsSearchService } from '@affine/core/modules/docs-search';
import type { BlockModel, Store } from '@blocksuite/affine/store';
import { firstValueFrom, timeout } from 'rxjs';

import type { LocalWorkspaceContent } from './backend';
import {
  addDatabaseColumn,
  addDatabaseRows,
  createDatabase,
  deleteDatabaseRows,
  listDatabases,
  readDatabase,
  updateDatabaseRows,
} from './database-tools';
import {
  appendMarkdown,
  applyTaggedMarkdown,
  exportTaggedMarkdown,
  insertionPoint,
  resolveDocId,
  resolveDocLinks,
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
  ) => Promise<{ data: Uint8Array; mime?: string } | null | undefined>,
  /** tags and properties, see `createLocalWorkspaceMeta` */
  meta?: Partial<LocalWorkspaceContent>
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

  const liveDocs = () =>
    docsService.list.docs$.value
      .filter(record => !record.trash$.value)
      .map(record => ({ id: record.id, title: record.title$.value }));
  const resolveLinks = (markdown: string) =>
    resolveDocLinks(markdown, liveDocs());

  return {
    ...meta,
    resolveDocId: idOrTitle => resolveDocId(idOrTitle, liveDocs()),
    async searchDocs(query, limit = 10) {
      const wanted = query.trim().toLowerCase();
      if (!wanted) return [];
      // Title matches come first and do not depend on the full-text index,
      // which may still be building right after the app starts.
      const titleHits = docsService.list.docs$.value
        .filter(record => !record.trash$.value)
        .map(record => ({ record, title: record.title$.value.trim() }))
        .filter(({ title }) => title && title.toLowerCase().includes(wanted))
        .sort(
          (a, b) =>
            Number(b.title.toLowerCase() === wanted) -
              Number(a.title.toLowerCase() === wanted) ||
            a.title.length - b.title.length
        )
        .map(({ record, title }) => ({
          docId: record.id,
          title,
          excerpt: '',
        }));
      const indexHits = await firstValueFrom(
        docsSearchService.search$(query, 'local').pipe(timeout(10_000))
      ).catch(() => []);
      const seen = new Set<string>();
      return [
        ...titleHits,
        ...indexHits
          .filter(hit => !docsService.list.doc$(hit.docId).value?.trash$.value)
          .map(hit => ({
            docId: hit.docId,
            title: hit.title || 'Untitled',
            excerpt: hit.blockContent,
          })),
      ]
        .filter(hit => {
          if (seen.has(hit.docId)) return false;
          seen.add(hit.docId);
          return true;
        })
        .slice(0, limit);
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
    async getDocLinks(docId) {
      if (!docsService.list.doc$(docId).value) return null;
      const live = (id: string) => {
        const record = docsService.list.doc$(id).value;
        return record && !record.trash$.value ? record : null;
      };
      const outgoing = await firstValueFrom(
        docsSearchService.watchRefsFrom(docId).pipe(timeout(10_000))
      ).catch(() => []);
      const { buckets } = await docsSearchService.indexer
        .aggregate(
          'block',
          { type: 'match', field: 'refDocId', match: docId },
          'docId',
          {
            hits: {
              fields: ['docId', 'markdownPreview'],
              pagination: { limit: 1 },
            },
            pagination: { limit: 100 },
            prefer: 'local',
          }
        )
        .catch(() => ({ buckets: [] as any[] }));
      return {
        docId,
        links: outgoing
          .filter(ref => live(ref.docId))
          .map(ref => ({ docId: ref.docId, title: ref.title || 'Untitled' })),
        backlinks: buckets
          .filter(bucket => bucket.key !== docId && live(bucket.key))
          .map(bucket => {
            const preview = bucket.hits.nodes[0]?.fields.markdownPreview;
            return {
              docId: bucket.key,
              title: live(bucket.key)?.title$.value || 'Untitled',
              excerpt:
                (typeof preview === 'string' ? preview : preview?.[0]) ||
                undefined,
            };
          }),
      };
    },
    async database(docId, action, args) {
      return withDoc(docId, async doc => {
        const store = doc.blockSuiteDoc;
        const blockId = String(args.block_id ?? '');
        switch (action) {
          case 'list':
            return listDatabases(store);
          case 'read':
            return readDatabase(store, blockId);
          case 'create': {
            const { parentId, index } = insertionPoint(
              store,
              args.after_block_id ? String(args.after_block_id) : undefined
            );
            const id = createDatabase(store, parentId, index, {
              title: String(args.title ?? 'Database'),
              columns: Array.isArray(args.columns) ? args.columns : [],
              view: args.view === 'kanban' ? 'kanban' : 'table',
            });
            const rows = Array.isArray(args.rows) ? args.rows : [];
            const added = rows.length ? addDatabaseRows(store, id, rows) : null;
            return { blockId: id, rows: added?.rowIds.length ?? 0 };
          }
          case 'add_rows':
            return addDatabaseRows(
              store,
              blockId,
              Array.isArray(args.rows) ? args.rows : []
            );
          case 'update_rows':
            return updateDatabaseRows(
              store,
              blockId,
              (Array.isArray(args.rows) ? args.rows : []).map((row: any) => ({
                rowId: String(row.row_id ?? row.rowId ?? ''),
                title: row.title,
                values: row.values,
              }))
            );
          case 'delete_rows':
            return deleteDatabaseRows(
              store,
              blockId,
              (Array.isArray(args.row_ids) ? args.row_ids : []).map(String)
            );
          case 'add_column':
            return addDatabaseColumn(
              store,
              blockId,
              String(args.name ?? ''),
              String(args.type ?? 'rich-text')
            );
          default:
            throw new Error(`Unknown database action ${action}`);
        }
      });
    },
    async createDoc(title, markdown) {
      const content = resolveLinks(markdown);
      const record = docsService.createDoc({ title, primaryMode: 'page' });
      const inserted = await withDoc(record.id, doc =>
        appendMarkdown(doc.blockSuiteDoc, content)
      );
      return { docId: record.id, title, blocks: inserted ?? 0 };
    },
    async editDoc(docId, markdown) {
      const content = resolveLinks(markdown);
      return withDoc(docId, doc =>
        applyTaggedMarkdown(doc.blockSuiteDoc, content)
      );
    },
    async appendToDoc(docId, markdown, afterBlockId) {
      const content = resolveLinks(markdown);
      const inserted = await withDoc(docId, doc =>
        appendMarkdown(doc.blockSuiteDoc, content, afterBlockId)
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
