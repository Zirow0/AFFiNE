import {
  defaultImageProxyMiddleware,
  embedSyncedDocMiddleware,
  HtmlAdapter,
  MarkdownAdapter,
  titleMiddleware,
} from '@blocksuite/affine/shared/adapters';
import {
  type BlockModel,
  Slice,
  type Store,
  type TransformerMiddleware,
} from '@blocksuite/affine/store';

/**
 * Block-addressed Markdown for AI document editing (page mode only).
 *
 * Every top-level block of the doc's note is preceded by a marker:
 *
 *   <!-- block_id=abc123 flavour=affine:paragraph -->
 *   Some **rich** text
 *
 * The model edits a doc by returning the full Markdown with the markers of the
 * blocks it keeps; unchanged blocks are left untouched (ids, comments and
 * history survive), changed ones are re-created from Markdown, blocks without
 * a known marker are inserted and missing ones are deleted.
 */

/**
 * Links to other docs are written as `[text](affine://doc/<docId>)`; the
 * Markdown adapters turn such links into real doc references both ways.
 * `?blockIds=<id>` targets a block inside the doc.
 */
export const DOC_LINK_BASE = 'affine://doc';

const docLinkMiddleware: TransformerMiddleware = ({ adapterConfigs }) => {
  adapterConfigs.set('docLinkBaseUrl', DOC_LINK_BASE);
};

export type LocalDocImage = {
  blockId: string;
  blobId: string;
  caption: string;
};

const MARKER_RE = /^\s*<!--\s*block_id=(\S+)(?:\s+flavour=(\S+))?\s*-->\s*$/;

type ParsedBlock = { id: string | null; content: string };

export function parseTaggedMarkdown(markdown: string): {
  blocks: ParsedBlock[];
  tagged: boolean;
} {
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;
  let tagged = false;
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(MARKER_RE);
    if (match) {
      tagged = true;
      if (current) blocks.push(current);
      current = { id: match[1], content: '' };
      continue;
    }
    if (!current) current = { id: null, content: '' };
    current.content += (current.content ? '\n' : '') + line;
  }
  if (current) blocks.push(current);
  return {
    tagged,
    blocks: blocks
      .map(block => ({ ...block, content: block.content.trim() }))
      .filter(block => block.id !== null || block.content),
  };
}

function pageNote(store: Store): BlockModel | null {
  const notes = store.getBlocksByFlavour('affine:note').map(b => b.model);
  // page mode shows notes that are not edgeless-only
  return (
    notes.find(
      note =>
        (note.props as { displayMode?: string }).displayMode !== 'edgeless'
    ) ??
    notes[0] ??
    null
  );
}

function ensurePageNote(store: Store): BlockModel {
  const existing = pageNote(store);
  if (existing) return existing;
  const root = store.root;
  if (!root) throw new Error('Document has no root block');
  const id = store.addBlock('affine:note', {}, root.id);
  const note = store.getBlock(id)?.model;
  if (!note) throw new Error('Failed to create a note block');
  return note;
}

function normalize(content: string) {
  return content.replace(/\s+$/gm, '').trim();
}

async function blockToMarkdown(store: Store, model: BlockModel) {
  if (model.flavour === 'affine:image') {
    const props = model.props as { sourceId?: string; caption?: string };
    return `![${props.caption ?? ''}](affine-image:${props.sourceId ?? ''})`;
  }
  const transformer = store.getTransformer([
    docLinkMiddleware,
    titleMiddleware(store.workspace.meta.docMetas),
    embedSyncedDocMiddleware('content'),
  ]);
  const snapshot = transformer.sliceToSnapshot(
    Slice.fromModels(store, [model])
  );
  if (!snapshot) return '';
  const adapter = new MarkdownAdapter(transformer, store.provider);
  const result = await adapter.fromSliceSnapshot({
    snapshot,
    assets: transformer.assetsManager,
  });
  return result.file.trim();
}

function collectImages(model: BlockModel, out: LocalDocImage[]) {
  if (model.flavour === 'affine:image') {
    const props = model.props as { sourceId?: string; caption?: string };
    if (props.sourceId) {
      out.push({
        blockId: model.id,
        blobId: props.sourceId,
        caption: props.caption ?? '',
      });
    }
  }
  model.children.forEach(child => collectImages(child, out));
}

/** Exports the page content as block-tagged Markdown plus its images. */
export async function exportTaggedMarkdown(store: Store) {
  const note = pageNote(store);
  const images: LocalDocImage[] = [];
  const parts: string[] = [];
  if (note) {
    for (const child of note.children) {
      collectImages(child, images);
      const markdown = await blockToMarkdown(store, child).catch(() => '');
      parts.push(
        `<!-- block_id=${child.id} flavour=${child.flavour} -->\n${markdown}`
      );
    }
  }
  return { markdown: parts.join('\n\n'), images };
}

export type DocEditStats = {
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
};

/** Models sometimes answer with HTML although Markdown was requested. */
export function looksLikeHtml(content: string) {
  return /^\s*<(h[1-6]|p|ul|ol|li|div|table|blockquote|pre|section|article)\b/i.test(
    content
  );
}

async function insertHtml(
  store: Store,
  note: BlockModel,
  html: string,
  index: number
) {
  const transformer = store.getTransformer([
    defaultImageProxyMiddleware,
    docLinkMiddleware,
  ]);
  const adapter = new HtmlAdapter(transformer, store.provider);
  const snapshot = await adapter.toSliceSnapshot({
    file: html,
    assets: transformer.assetsManager,
    workspaceId: store.workspace.id,
    pageId: store.id,
  });
  const blocks = snapshot?.content.flatMap(block => block.children) ?? [];
  let inserted = 0;
  for (const block of blocks) {
    const model = await transformer.snapshotToBlock(
      block,
      store,
      note.id,
      index + inserted
    );
    if (model) inserted++;
  }
  return inserted;
}

async function insertAt(
  store: Store,
  note: BlockModel,
  content: string,
  index: number,
  id?: string
) {
  if (!content.trim()) return 0;
  if (looksLikeHtml(content)) return insertHtml(store, note, content, index);
  const transformer = store.getTransformer([
    defaultImageProxyMiddleware,
    docLinkMiddleware,
  ]);
  const adapter = new MarkdownAdapter(transformer, store.provider);
  const snapshot = await adapter.toSliceSnapshot({
    file: content,
    assets: transformer.assetsManager,
    workspaceId: store.workspace.id,
    pageId: store.id,
  });
  const blocks = snapshot?.content.flatMap(block => block.children) ?? [];
  let inserted = 0;
  for (const block of blocks) {
    // keep the id of an edited block when it stays a single block
    if (blocks.length === 1 && id) block.id = id;
    const model = await transformer.snapshotToBlock(
      block,
      store,
      note.id,
      index + inserted
    );
    if (model) inserted++;
  }
  return inserted;
}

/**
 * Applies block-tagged Markdown to the page. Untagged Markdown replaces the
 * whole page body.
 */
export async function applyTaggedMarkdown(
  store: Store,
  markdown: string
): Promise<DocEditStats> {
  const note = ensurePageNote(store);
  const { blocks, tagged } = parseTaggedMarkdown(markdown);
  const stats: DocEditStats = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
  };

  const existing = new Map(note.children.map(child => [child.id, child]));
  const kept = new Set(
    tagged
      ? blocks.flatMap(block =>
          block.id && existing.has(block.id) ? [block.id] : []
        )
      : []
  );

  // 1. delete blocks the new version no longer contains
  // copy: deleting while iterating the live children array would skip items
  for (const child of note.children.slice()) {
    if (!kept.has(child.id)) {
      store.deleteBlock(child);
      stats.deleted++;
    }
  }

  // 2. walk the new version in order, keeping/updating/inserting blocks
  let index = 0;
  for (const block of blocks) {
    const model = block.id ? existing.get(block.id) : undefined;
    if (model && kept.has(model.id)) {
      const currentIndex = note.children.indexOf(model);
      if (currentIndex !== index) {
        const sibling = note.children[index] ?? null;
        store.moveBlocks([model], note, sibling, true);
      }
      // images/databases cannot be re-created from Markdown; keep them as they are
      const before = normalize(await blockToMarkdown(store, model));
      if (
        // images and databases are edited with dedicated tools only
        model.flavour === 'affine:image' ||
        model.flavour === 'affine:database' ||
        before === normalize(block.content)
      ) {
        stats.unchanged++;
        index++;
        continue;
      }
      // re-create the block from Markdown, keeping its id when it stays one block
      store.deleteBlock(model);
      const count = await insertAt(store, note, block.content, index, model.id);
      stats.updated++;
      index += count;
      continue;
    }
    const count = await insertAt(store, note, block.content, index);
    stats.inserted += count;
    index += count;
  }
  return stats;
}

/** Appends Markdown at the end (or after `afterBlockId`) of the page. */
export async function appendMarkdown(
  store: Store,
  markdown: string,
  afterBlockId?: string
) {
  const note = ensurePageNote(store);
  let index = note.children.length;
  if (afterBlockId) {
    const at = note.children.findIndex(child => child.id === afterBlockId);
    if (at === -1) throw new Error(`Block ${afterBlockId} not found`);
    index = at + 1;
  }
  return insertAt(store, note, markdown, index);
}

/** Where to insert a new top-level block: at the end or after a block. */
export function insertionPoint(store: Store, afterBlockId?: string) {
  const note = ensurePageNote(store);
  if (!afterBlockId) return { parentId: note.id, index: note.children.length };
  const at = note.children.findIndex(child => child.id === afterBlockId);
  if (at === -1) throw new Error(`Block ${afterBlockId} not found`);
  return { parentId: note.id, index: at + 1 };
}
