import { DatabaseBlockDataSource } from '@blocksuite/affine/blocks/database';
import type { DatabaseBlockModel } from '@blocksuite/affine/model';
import { type BlockModel, type Store, Text } from '@blocksuite/affine/store';

/**
 * Database blocks for the on-device AI. Cell values are exchanged as plain
 * text and converted with each column type's own `rawValue.toString` /
 * `fromString`, exactly like copy & paste in the app (select options that do
 * not exist yet are created automatically).
 */

export const DATABASE_COLUMN_TYPES = [
  'rich-text',
  'number',
  'select',
  'multi-select',
  'checkbox',
  'date',
  'progress',
  'link',
] as const;

export type DatabaseColumnInfo = {
  id: string;
  name: string;
  type: string;
  options?: string[];
};

export class DatabaseToolError extends Error {
  override name = 'DatabaseToolError';
}

function databaseModels(store: Store) {
  return store
    .getBlocksByFlavour('affine:database')
    .map(block => block.model as DatabaseBlockModel);
}

function requireDatabase(store: Store, blockId: string) {
  const model = store.getBlock(blockId)?.model;
  if (!model || model.flavour !== 'affine:database') {
    throw new DatabaseToolError(
      `Block ${blockId} is not a database. Use database_list to find databases.`
    );
  }
  return model as DatabaseBlockModel;
}

function columnsOf(source: DatabaseBlockDataSource): DatabaseColumnInfo[] {
  return source.properties$.value
    .filter(id => source.propertyTypeGet(id) !== 'title')
    .map(id => {
      const type = source.propertyTypeGet(id) ?? 'unknown';
      const data = source.propertyDataGet(id) as {
        options?: { value: string }[];
      };
      return {
        id,
        name: source.propertyNameGet(id),
        type,
        ...(Array.isArray(data?.options)
          ? { options: data.options.map(o => o.value) }
          : {}),
      };
    });
}

function rowTitle(store: Store, rowId: string) {
  const text = (store.getBlock(rowId)?.model.props as { text?: Text })?.text;
  return text?.toString() ?? '';
}

function setRowTitle(store: Store, rowId: string, title: string) {
  const model = store.getBlock(rowId)?.model as BlockModel | undefined;
  const text = (model?.props as { text?: Text })?.text;
  if (!text) return;
  text.replace(0, text.length, title);
}

function cellToString(
  source: DatabaseBlockDataSource,
  rowId: string,
  columnId: string
) {
  const type = source.propertyTypeGet(columnId);
  const meta = type ? source.propertyMetaGet(type) : undefined;
  if (!meta) return '';
  const value = source.cellValueGet(rowId, columnId);
  if (value === undefined || value === null) return '';
  try {
    return meta.config.rawValue.toString({
      value,
      data: source.propertyDataGet(columnId),
    });
  } catch {
    return String(value);
  }
}

function findColumn(source: DatabaseBlockDataSource, key: string) {
  const wanted = key.trim().toLowerCase();
  const columns = columnsOf(source);
  return (
    columns.find(c => c.id === key) ??
    columns.find(c => c.name.trim().toLowerCase() === wanted) ??
    null
  );
}

function isTitleKey(key: string) {
  return ['title', 'name', 'row', '_title'].includes(key.trim().toLowerCase());
}

function setCells(
  store: Store,
  source: DatabaseBlockDataSource,
  rowId: string,
  values: Record<string, unknown>
) {
  const unknown: string[] = [];
  for (const [key, raw] of Object.entries(values ?? {})) {
    const text = Array.isArray(raw)
      ? raw.map(String).join(', ')
      : raw === null || raw === undefined
        ? ''
        : String(raw);
    const column = findColumn(source, key);
    if (!column) {
      if (isTitleKey(key)) {
        setRowTitle(store, rowId, text);
      } else {
        unknown.push(key);
      }
      continue;
    }
    const meta = source.propertyMetaGet(column.type);
    if (!meta) continue;
    const parsed = meta.config.rawValue.fromString({
      value: text,
      data: source.propertyDataGet(column.id),
      dataSource: source,
    });
    if (parsed.data) source.propertyDataSet(column.id, parsed.data);
    source.cellValueChange(rowId, column.id, parsed.value);
  }
  return unknown;
}

export function listDatabases(store: Store) {
  return databaseModels(store).map(model => {
    const source = new DatabaseBlockDataSource(model);
    return {
      blockId: model.id,
      title: model.props.title.toString(),
      columns: columnsOf(source),
      rowCount: source.rows$.value.length,
    };
  });
}

export function readDatabase(store: Store, blockId: string, limit = 200) {
  const model = requireDatabase(store, blockId);
  const source = new DatabaseBlockDataSource(model);
  const columns = columnsOf(source);
  const rowIds = source.rows$.value;
  return {
    blockId,
    title: model.props.title.toString(),
    columns,
    rows: rowIds.slice(0, limit).map(rowId => ({
      rowId,
      title: rowTitle(store, rowId),
      values: Object.fromEntries(
        columns.map(column => [
          column.name,
          cellToString(source, rowId, column.id),
        ])
      ),
    })),
    truncated: rowIds.length > limit,
  };
}

export function createDatabase(
  store: Store,
  parentId: string,
  index: number,
  input: {
    title: string;
    columns: { name: string; type: string }[];
    view?: 'table' | 'kanban';
  }
) {
  for (const column of input.columns) {
    if (!(DATABASE_COLUMN_TYPES as readonly string[]).includes(column.type)) {
      throw new DatabaseToolError(
        `Unsupported column type "${column.type}". Use one of: ${DATABASE_COLUMN_TYPES.join(', ')}`
      );
    }
  }
  const id = store.addBlock(
    'affine:database',
    { title: new Text(input.title) },
    parentId,
    index
  );
  const model = requireDatabase(store, id);
  const source = new DatabaseBlockDataSource(model);
  for (const column of input.columns) {
    source.propertyAdd('end', { type: column.type, name: column.name });
  }
  const view = input.view === 'kanban' ? 'kanban' : 'table';
  try {
    source.viewManager.viewAdd(view);
  } catch {
    // kanban needs a select column to group by
    source.viewManager.viewAdd('table');
  }
  return id;
}

export function addDatabaseRows(
  store: Store,
  blockId: string,
  rows: { title?: string; values?: Record<string, unknown> }[]
) {
  const model = requireDatabase(store, blockId);
  const source = new DatabaseBlockDataSource(model);
  const unknown = new Set<string>();
  const rowIds = rows.map(row => {
    const rowId = source.rowAdd('end');
    if (row.title) setRowTitle(store, rowId, String(row.title));
    setCells(store, source, rowId, row.values ?? {}).forEach(k =>
      unknown.add(k)
    );
    return rowId;
  });
  return { rowIds, unknownColumns: [...unknown] };
}

export function updateDatabaseRows(
  store: Store,
  blockId: string,
  rows: { rowId: string; title?: string; values?: Record<string, unknown> }[]
) {
  const model = requireDatabase(store, blockId);
  const source = new DatabaseBlockDataSource(model);
  const existing = new Set(source.rows$.value);
  const missing: string[] = [];
  const unknown = new Set<string>();
  let updated = 0;
  for (const row of rows) {
    if (!existing.has(row.rowId)) {
      missing.push(row.rowId);
      continue;
    }
    if (row.title !== undefined)
      setRowTitle(store, row.rowId, String(row.title));
    setCells(store, source, row.rowId, row.values ?? {}).forEach(k =>
      unknown.add(k)
    );
    updated++;
  }
  return { updated, missingRows: missing, unknownColumns: [...unknown] };
}

export function deleteDatabaseRows(
  store: Store,
  blockId: string,
  rowIds: string[]
) {
  const model = requireDatabase(store, blockId);
  const source = new DatabaseBlockDataSource(model);
  const existing = new Set(source.rows$.value);
  const toDelete = rowIds.filter(id => existing.has(id));
  source.rowDelete(toDelete);
  return { deleted: toDelete.length };
}

export function addDatabaseColumn(
  store: Store,
  blockId: string,
  name: string,
  type: string
) {
  if (!(DATABASE_COLUMN_TYPES as readonly string[]).includes(type)) {
    throw new DatabaseToolError(
      `Unsupported column type "${type}". Use one of: ${DATABASE_COLUMN_TYPES.join(', ')}`
    );
  }
  const model = requireDatabase(store, blockId);
  const source = new DatabaseBlockDataSource(model);
  const existing = findColumn(source, name);
  if (existing) return { ...existing, existed: true };
  const id = source.propertyAdd('end', { type, name });
  if (!id) throw new DatabaseToolError(`Could not add column "${name}"`);
  return { id, name: source.propertyNameGet(id), type, existed: false };
}
