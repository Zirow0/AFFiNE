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
