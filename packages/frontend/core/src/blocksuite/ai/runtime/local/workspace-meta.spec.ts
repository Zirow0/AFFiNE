import { beforeEach, describe, expect, test } from 'vitest';

import { createLocalWorkspaceMeta, PropertyValueError } from './workspace-meta';

const live = <T>(value: T) => ({ value });

type FakeTag = {
  id: string;
  value$: { value: string };
  color$: { value: string };
  pageIds$: { value: string[] };
  tag(docId: string): void;
  untag(docId: string): void;
};

function setup() {
  const docs = new Map<
    string,
    {
      id: string;
      title: string;
      trash: boolean;
      props: Record<string, unknown>;
      mode?: string;
    }
  >([
    ['d1', { id: 'd1', title: 'Plan', trash: false, props: {} }],
    ['d2', { id: 'd2', title: 'Notes', trash: false, props: {} }],
    ['d3', { id: 'd3', title: 'Old', trash: true, props: {} }],
  ]);
  const tags: FakeTag[] = [];
  const makeTag = (id: string, name: string, pageIds: string[]) => {
    const tag: FakeTag = {
      id,
      value$: live(name),
      color$: live('#f00'),
      pageIds$: live(pageIds),
      tag: docId => {
        if (!tag.pageIds$.value.includes(docId)) tag.pageIds$.value.push(docId);
      },
      untag: docId => {
        tag.pageIds$.value = tag.pageIds$.value.filter(id => id !== docId);
      },
    };
    tags.push(tag);
    return tag;
  };
  makeTag('t1', 'Work', ['d1', 'd3']);
  makeTag('t2', 'Ideas', []);

  const properties = [
    { id: 'tags', type: 'tags', index: 'a1' },
    { id: 'docPrimaryMode', type: 'docPrimaryMode', index: 'a2' },
    { id: 'template', type: 'template', index: 'a3' },
    { id: 'createdAt', type: 'createdAt', index: 'a4' },
    { id: 'pageWidth', type: 'pageWidth', index: 'a5' },
    { id: 'p-budget', name: 'Budget', type: 'number', index: 'b1' },
    { id: 'p-done', name: 'Done', type: 'checkbox', index: 'b2' },
    { id: 'p-due', name: 'Due', type: 'date', index: 'b3' },
    { id: 'p-gone', name: 'Gone', type: 'text', index: 'b4', isDeleted: true },
  ] as any[];

  const record = (id: string) => {
    const doc = docs.get(id);
    if (!doc) return undefined;
    return {
      id,
      trash$: live(doc.trash),
      title$: live(doc.title),
      createdAt$: live(Date.UTC(2026, 0, 2)),
      updatedAt$: live(Date.UTC(2026, 0, 3)),
      getProperties: () => doc.props,
      getPrimaryMode: () => doc.mode,
      setPrimaryMode: (mode: string) => (doc.mode = mode),
      setProperty: (key: string, value: unknown) => (doc.props[key] = value),
      setCustomProperty: (key: string, value: string) =>
        (doc.props['custom:' + key] = value),
    };
  };

  const docsService = {
    list: { doc$: (id: string) => live(record(id)) },
  } as any;
  const tagService = {
    randomTagColor: () => '#0f0',
    tagList: {
      tags$: live(tags),
      createTag: (name: string) => makeTag(`t${tags.length + 1}`, name, []),
      tagsByPageId$: (docId: string) =>
        live(tags.filter(tag => tag.pageIds$.value.includes(docId))),
    },
  } as any;
  const propertyService = {
    sortedProperties$: live(properties),
    indexAt: () => 'z',
    createProperty: (info: any) => {
      const created = { id: `p-${info.name.toLowerCase()}`, ...info };
      properties.push(created);
      return created;
    },
  } as any;

  return {
    docs,
    meta: createLocalWorkspaceMeta(docsService, tagService, propertyService),
  };
}

let env: ReturnType<typeof setup>;
beforeEach(() => {
  env = setup();
});

describe('local AI tags and properties', () => {
  test('lists tags with live document counts', async () => {
    expect(await env.meta.listTags!()).toEqual([
      { id: 't2', name: 'Ideas', color: '#f00', docCount: 0 },
      { id: 't1', name: 'Work', color: '#f00', docCount: 1 },
    ]);
    expect(await env.meta.docsByTag!('work')).toEqual({
      tag: { id: 't1', name: 'Work' },
      docs: [{ docId: 'd1', title: 'Plan' }],
    });
    expect(await env.meta.docsByTag!('missing')).toBeNull();
  });

  test('lists properties with names and editability', async () => {
    const list = await env.meta.listProperties!();
    expect(list.map(p => [p.name, p.type, p.editable])).toEqual([
      ['Tags', 'tags', true],
      ['Doc mode', 'docPrimaryMode', true],
      ['Template', 'template', true],
      ['Created', 'createdAt', false],
      ['Page width', 'pageWidth', true],
      ['Budget', 'number', true],
      ['Done', 'checkbox', true],
      ['Due', 'date', true],
    ]);
  });

  test('adds, creates and removes tags', async () => {
    const result = await env.meta.setDocTags!('d1', {
      add: ['Ideas', 'Urgent'],
      remove: ['Work'],
    });
    expect(result).toEqual({ tags: ['Ideas', 'Urgent'], created: ['Urgent'] });
    expect(await env.meta.setDocTags!('d3', { add: ['x'] })).toBeNull();
  });

  test('sets typed custom and built-in properties', async () => {
    await env.meta.setDocProperty!('d2', 'Budget', '1 500,5'.replace(' ', ''));
    await env.meta.setDocProperty!('d2', 'done', 'yes');
    await env.meta.setDocProperty!('d2', 'p-due', '2026-03-15');
    await env.meta.setDocProperty!('d2', 'Doc mode', 'Edgeless');
    await env.meta.setDocProperty!('d2', 'Template', 'true');
    await env.meta.setDocProperty!('d2', 'Page width', 'full');
    expect(env.docs.get('d2')).toMatchObject({
      mode: 'edgeless',
      props: {
        'custom:p-budget': '1500.5',
        'custom:p-done': 'true',
        'custom:p-due': '2026-03-15',
        isTemplate: true,
        pageWidth: 'fullWidth',
      },
    });
    const props = await env.meta.getDocProperties!('d2');
    const byName = Object.fromEntries(
      props!.properties.map(p => [p.name, p.value])
    );
    expect(byName).toMatchObject({
      Tags: [],
      'Doc mode': 'edgeless',
      Template: 'true',
      Created: '2026-01-02T00:00:00.000Z',
      Budget: '1500.5',
      Done: 'true',
      Due: '2026-03-15',
    });
  });

  test('rejects invalid values and read-only properties', async () => {
    await expect(
      env.meta.setDocProperty!('d1', 'Budget', 'a lot')
    ).rejects.toBeInstanceOf(PropertyValueError);
    await expect(
      env.meta.setDocProperty!('d1', 'Due', '15.03.2026')
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      env.meta.setDocProperty!('d1', 'Created', '2020-01-01')
    ).rejects.toThrow(/cannot be changed/);
    await expect(env.meta.setDocProperty!('d1', 'Tags', 'x')).rejects.toThrow(
      /doc_set_tags/
    );
    await expect(env.meta.setDocProperty!('d1', 'Nope', 'x')).rejects.toThrow(
      /Unknown property/
    );
  });

  test('creates a property once', async () => {
    expect(await env.meta.createProperty!('Status', 'text')).toMatchObject({
      id: 'p-status',
      existed: false,
    });
    expect(await env.meta.createProperty!('status', 'text')).toMatchObject({
      id: 'p-status',
      existed: true,
    });
    await expect(env.meta.createProperty!('X', 'tags')).rejects.toThrow(
      /must be one of/
    );
  });
});
