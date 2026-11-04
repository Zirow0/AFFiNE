/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';

import { getStoreManager } from '@affine/core/blocksuite/manager/store';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { describe, expect, test } from 'vitest';

import {
  addDatabaseColumn,
  addDatabaseRows,
  createDatabase,
  deleteDatabaseRows,
  listDatabases,
  readDatabase,
  updateDatabaseRows,
} from './database-tools';
import { applyTaggedMarkdown, exportTaggedMarkdown } from './doc-tools';

const extensions = getStoreManager().config.init().value.get('store');

function createPage() {
  const collection = new TestWorkspace({ id: 'test' });
  collection.meta.initialize();
  const store = collection.createDoc('page0').getStore({ extensions });
  store.load();
  const rootId = store.addBlock('affine:page', { title: new Text('Doc') });
  const noteId = store.addBlock('affine:note', {}, rootId);
  store.addBlock('affine:paragraph', { text: new Text('Intro') }, noteId);
  return { store, noteId };
}

describe('database tools', () => {
  test('creates a database with typed columns and rows', () => {
    const { store, noteId } = createPage();
    const blockId = createDatabase(store, noteId, 1, {
      title: 'Tasks',
      columns: [
        { name: 'Status', type: 'select' },
        { name: 'Estimate', type: 'number' },
        { name: 'Done', type: 'checkbox' },
        { name: 'Due', type: 'date' },
        { name: 'Labels', type: 'multi-select' },
      ],
    });
    const added = addDatabaseRows(store, blockId, [
      {
        title: 'Write docs',
        values: {
          Status: 'In progress',
          Estimate: '3',
          Done: 'false',
          Due: '2026-03-15',
          Labels: 'docs, ai',
        },
      },
      { title: 'Ship', values: { status: 'Todo', Unknown: 'x' } },
    ]);
    expect(added.rowIds).toHaveLength(2);
    expect(added.unknownColumns).toEqual(['Unknown']);

    const [db] = listDatabases(store);
    expect(db).toMatchObject({ blockId, title: 'Tasks', rowCount: 2 });
    expect(db.columns.find(c => c.name === 'Status')?.options).toEqual([
      'In progress',
      'Todo',
    ]);

    const read = readDatabase(store, blockId);
    expect(read.rows[0]).toMatchObject({
      title: 'Write docs',
      values: {
        Status: 'In progress',
        Estimate: '3',
        Done: 'False',
        Labels: 'docs,ai',
      },
    });
    expect(read.rows[0].values.Due).toMatch(/2026/);
    expect(read.rows[1].values.Status).toBe('Todo');
  });

  test('updates, deletes rows and adds columns', () => {
    const { store, noteId } = createPage();
    const blockId = createDatabase(store, noteId, 1, {
      title: 'Inventory',
      columns: [{ name: 'Qty', type: 'number' }],
    });
    const { rowIds } = addDatabaseRows(store, blockId, [
      { title: 'Apples', values: { Qty: '3' } },
      { title: 'Pears', values: { Qty: '1' } },
    ]);
    const result = updateDatabaseRows(store, blockId, [
      { rowId: rowIds[0], title: 'Green apples', values: { Qty: '5' } },
      { rowId: 'missing', values: { Qty: '1' } },
    ]);
    expect(result).toEqual({
      updated: 1,
      missingRows: ['missing'],
      unknownColumns: [],
    });
    expect(deleteDatabaseRows(store, blockId, [rowIds[1]])).toEqual({
      deleted: 1,
    });
    expect(
      addDatabaseColumn(store, blockId, 'Note', 'rich-text')
    ).toMatchObject({ name: 'Note', existed: false });
    expect(addDatabaseColumn(store, blockId, 'qty', 'number')).toMatchObject({
      existed: true,
    });
    const read = readDatabase(store, blockId);
    expect(read.rows).toEqual([
      {
        rowId: rowIds[0],
        title: 'Green apples',
        values: { Qty: '5', Note: '' },
      },
    ]);
    expect(() => addDatabaseColumn(store, blockId, 'X', 'formula')).toThrow(
      /Unsupported column type/
    );
  });

  test('doc edits keep database blocks intact', async () => {
    const { store, noteId } = createPage();
    const blockId = createDatabase(store, noteId, 1, {
      title: 'Kept',
      columns: [{ name: 'Qty', type: 'number' }],
    });
    addDatabaseRows(store, blockId, [{ title: 'A', values: { Qty: '1' } }]);
    const { markdown } = await exportTaggedMarkdown(store);
    // the model rewrites the intro and garbles the database part
    const edited = markdown
      .replace('Intro', 'New intro')
      .replace(
        /(block_id=[^\s]+ flavour=affine:database -->)[\s\S]*$/,
        '$1\n| broken |'
      );
    await applyTaggedMarkdown(store, edited);
    expect(readDatabase(store, blockId).rows[0].values.Qty).toBe('1');
  });
});
