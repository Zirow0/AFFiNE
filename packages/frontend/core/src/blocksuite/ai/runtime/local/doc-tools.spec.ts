/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';

import { getStoreManager } from '@affine/core/blocksuite/manager/store';
import { type Store, Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { describe, expect, test } from 'vitest';

import { insertFromMarkdown } from '../../../utils';
import {
  appendMarkdown,
  applyTaggedMarkdown,
  exportTaggedMarkdown,
  parseTaggedMarkdown,
  resolveDocLinks,
} from './doc-tools';

const extensions = getStoreManager().config.init().value.get('store');

async function createPage(markdown: string) {
  const collection = new TestWorkspace({ id: 'test' });
  collection.meta.initialize();
  const store = collection.createDoc('page0').getStore({ extensions });
  store.load();
  const rootId = store.addBlock('affine:page', { title: new Text('Doc') });
  const noteId = store.addBlock('affine:note', {}, rootId);
  await insertFromMarkdown(undefined, markdown, store, noteId, 0);
  return store;
}

function note(store: Store) {
  return store.getBlocksByFlavour('affine:note')[0].model;
}

function flavours(store: Store) {
  return note(store).children.map(child => child.flavour);
}

describe('block-tagged markdown', () => {
  test('exports every top-level block with its id', async () => {
    const store = await createPage(
      ['# Title', 'Hello **world**', '- a', '- b'].join('\n\n')
    );
    const { markdown } = await exportTaggedMarkdown(store);
    const { blocks, tagged } = parseTaggedMarkdown(markdown);
    expect(tagged).toBe(true);
    expect(blocks.map(b => b.id)).toEqual(note(store).children.map(c => c.id));
    expect(markdown).toContain('Hello **world**');
    expect(markdown).toContain('# Title');
  });

  test('keeps unchanged blocks, updates, inserts and deletes others', async () => {
    const store = await createPage(
      ['First paragraph', 'Second paragraph', 'Third paragraph'].join('\n\n')
    );
    const [first, second, third] = note(store).children;
    const { blocks } = parseTaggedMarkdown(
      (await exportTaggedMarkdown(store)).markdown
    );

    const edited = [
      `<!-- block_id=${first.id} flavour=affine:paragraph -->`,
      blocks[0].content,
      `<!-- block_id=${second.id} flavour=affine:paragraph -->`,
      'Second paragraph, **rewritten**',
      '<!-- block_id=new flavour=affine:paragraph -->',
      '## New section',
      '',
      '- item one',
      '- item two',
    ].join('\n');
    void third;

    const stats = await applyTaggedMarkdown(store, edited);
    expect(stats).toEqual({
      inserted: 3,
      updated: 1,
      deleted: 1,
      unchanged: 1,
    });

    const children = note(store).children;
    expect(children[0]).toBe(first); // untouched block is the same model
    expect(children[1].id).toBe(second.id); // updated block keeps its id
    expect(flavours(store)).toEqual([
      'affine:paragraph',
      'affine:paragraph',
      'affine:paragraph',
      'affine:list',
      'affine:list',
    ]);
    const text = (await exportTaggedMarkdown(store)).markdown;
    expect(text).toContain('Second paragraph, **rewritten**');
    expect(text).toContain('## New section');
    expect(text).not.toContain('Third paragraph');
  });

  test('inserts in the right place when blocks before it are deleted', async () => {
    const store = await createPage(['A', 'B', 'C'].join('\n\n'));
    const [a, , c] = note(store).children;
    const edited = [
      `<!-- block_id=${a.id} -->`,
      'A',
      `<!-- block_id=${c.id} -->`,
      'C',
      '<!-- block_id=new -->',
      'D',
    ].join('\n');
    await applyTaggedMarkdown(store, edited);
    const texts = note(store).children.map(child =>
      (child.props as { text?: Text }).text?.toString()
    );
    expect(texts).toEqual(['A', 'C', 'D']);
  });

  test('reorders kept blocks', async () => {
    const store = await createPage(['A', 'B'].join('\n\n'));
    const [a, b] = note(store).children;
    await applyTaggedMarkdown(
      store,
      [`<!-- block_id=${b.id} -->`, 'B', `<!-- block_id=${a.id} -->`, 'A'].join(
        '\n'
      )
    );
    expect(note(store).children.map(child => child.id)).toEqual([b.id, a.id]);
  });

  test('untagged markdown replaces the body', async () => {
    const store = await createPage(['Old 1', 'Old 2'].join('\n\n'));
    const stats = await applyTaggedMarkdown(store, '# Fresh\n\nNew body');
    expect(stats.deleted).toBe(2);
    expect(flavours(store)).toEqual(['affine:paragraph', 'affine:paragraph']);
    expect((await exportTaggedMarkdown(store)).markdown).toContain('# Fresh');
  });

  test('appends markdown with rich blocks', async () => {
    const store = await createPage('Intro');
    const [intro] = note(store).children;
    await appendMarkdown(
      store,
      [
        '```ts',
        'const x = 1;',
        '```',
        '',
        '- [ ] todo item',
        '',
        '> quote',
      ].join('\n')
    );
    await appendMarkdown(store, 'Right after intro', intro.id);
    expect(flavours(store)).toEqual([
      'affine:paragraph',
      'affine:paragraph',
      'affine:code',
      'affine:list',
      'affine:paragraph',
    ]);
    expect(
      (note(store).children[1].props as { text: Text }).text.toString()
    ).toBe('Right after intro');
  });
});

describe('html fallback', () => {
  test('turns HTML content into real blocks', async () => {
    const store = await createPage('Old');
    await applyTaggedMarkdown(
      store,
      '<h1>Groceries</h1>\n<ul><li>milk</li><li>bread</li></ul>'
    );
    expect(flavours(store)).toEqual([
      'affine:paragraph',
      'affine:list',
      'affine:list',
    ]);
  });
});

describe('links between documents', () => {
  test('writes and reads doc references as affine://doc links', async () => {
    const store = await createPage('Intro');
    // a second doc to link to, with a title known to the workspace meta
    const target = store.workspace.createDoc('target-doc');
    store.workspace.meta.setDocMeta('target-doc', { title: 'Budget 2026' });
    void target;

    await appendMarkdown(
      store,
      'See [the budget](affine://doc/target-doc) and [a block](affine://doc/target-doc?blockIds=b1).'
    );
    const paragraph = note(store).children.at(-1)!;
    const deltas = (paragraph.props as { text: Text }).text.toDelta() as Array<{
      insert: string;
      attributes?: { reference?: { pageId: string; params?: any } };
    }>;
    const refs = deltas.filter(d => d.attributes?.reference);
    expect(refs.map(r => r.attributes!.reference!.pageId)).toEqual([
      'target-doc',
      'target-doc',
    ]);
    expect(refs[1].attributes!.reference!.params?.blockIds).toEqual(['b1']);

    const { markdown } = await exportTaggedMarkdown(store);
    expect(markdown).toContain('[Budget 2026](affine://doc/target-doc)');
    expect(markdown).toContain('affine://doc/target-doc?blockIds=b1');
  });
});

describe('link target resolution', () => {
  const docs = [
    { id: 'abc123', title: 'Getting Started' },
    { id: 'def456', title: 'Budget 2026' },
  ];

  test('keeps real ids and resolves titles and placeholders', () => {
    expect(
      resolveDocLinks(
        [
          '[ok](affine://doc/abc123?blockIds=b1)',
          '[x](affine://doc/Getting-Started)',
          '[Budget 2026](affine://doc/<that id>)',
          '[y](affine://doc/budget_2026)',
        ].join(' '),
        docs
      )
    ).toBe(
      [
        '[ok](affine://doc/abc123?blockIds=b1)',
        '[x](affine://doc/abc123)',
        '[Budget 2026](affine://doc/def456)',
        '[y](affine://doc/def456)',
      ].join(' ')
    );
  });

  test('refuses links nothing matches', () => {
    expect(() => resolveDocLinks('[Nope](affine://doc/<id>)', docs)).toThrow(
      /do not exist: <id>/
    );
  });
});

describe('toggle lists and callouts', () => {
  test('toggle lists round-trip through the ▸ marker', async () => {
    const store = await createPage('Intro');
    await appendMarkdown(
      store,
      [
        '- ▸ Details',
        '  - hidden one',
        '- [>] Legacy marker',
        '- plain item',
      ].join('\n')
    );
    const lists = note(store).children.filter(c => c.flavour === 'affine:list');
    expect(
      lists.map(l => [
        (l.props as { type: string }).type,
        (l.props as { text: Text }).text.toString(),
      ])
    ).toEqual([
      ['toggle', 'Details'],
      ['toggle', 'Legacy marker'],
      ['bulleted', 'plain item'],
    ]);
    expect(lists[0].children).toHaveLength(1);

    const { markdown } = await exportTaggedMarkdown(store);
    expect(markdown).toContain('▸ Details');
    // re-applying the exported markdown changes nothing
    const stats = await applyTaggedMarkdown(store, markdown);
    expect(stats.updated + stats.inserted + stats.deleted).toBe(0);
    expect((lists[0].props as { type: string }).type).toBe('toggle');
  });

  test('quoted children of a toggle become its children', async () => {
    const store = await createPage('Intro');
    await appendMarkdown(store, '- ▸ Notes\n> - Buy organic if possible');
    const toggle = note(store).children.at(-1)!;
    expect((toggle.props as { type: string }).type).toBe('toggle');
    expect(toggle.children).toHaveLength(1);
    expect((toggle.children[0].props as { text: Text }).text.toString()).toBe(
      'Buy organic if possible'
    );
  });

  test('callouts accept emoji and GitHub-style markers', async () => {
    const store = await createPage('Intro');
    await appendMarkdown(
      store,
      [
        '> [!💡] Remember this',
        '',
        '> [!⚠️]',
        '> Careful',
        '',
        '> [!WARNING] Danger zone',
        '',
        '> just a quote',
      ].join('\n')
    );
    const blocks = note(store).children.slice(1);
    expect(
      blocks.map(b => [
        b.flavour,
        (b.props as { emoji?: string }).emoji ??
          (b.props as { type?: string }).type,
      ])
    ).toEqual([
      ['affine:callout', '💡'],
      ['affine:callout', '⚠'],
      ['affine:callout', '🚧'],
      ['affine:paragraph', 'quote'],
    ]);
    const firstText = (blocks[0].children[0].props as { text: Text }).text;
    expect(firstText.toString()).toBe('Remember this');
    const stats = await applyTaggedMarkdown(
      store,
      (await exportTaggedMarkdown(store)).markdown
    );
    expect(stats.updated + stats.inserted + stats.deleted).toBe(0);
  });
});
