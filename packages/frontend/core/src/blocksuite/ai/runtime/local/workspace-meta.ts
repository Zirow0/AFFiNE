import type { DocsService } from '@affine/core/modules/doc';
import type { TagService } from '@affine/core/modules/tag';
import type { WorkspacePropertyService } from '@affine/core/modules/workspace-property';

import type { LocalWorkspaceContent } from './backend';

/**
 * Tags and document properties for the on-device AI backend.
 *
 * Values follow what the property editors in the app store:
 * text/number as strings, checkbox as "true"/"false", date as YYYY-MM-DD.
 */

export type LocalPropertyInfo = {
  id: string;
  name: string;
  type: string;
  builtIn: boolean;
  editable: boolean;
};

const BUILT_IN_NAMES: Record<string, string> = {
  tags: 'Tags',
  docPrimaryMode: 'Doc mode',
  journal: 'Journal',
  template: 'Template',
  createdAt: 'Created',
  updatedAt: 'Updated',
  createdBy: 'Created by',
  updatedBy: 'Updated by',
  edgelessTheme: 'Edgeless theme',
  pageWidth: 'Page width',
};

/** custom property types the AI may set, with built-ins handled explicitly */
const EDITABLE_CUSTOM_TYPES = new Set(['text', 'number', 'checkbox', 'date']);
const EDITABLE_BUILT_INS = new Set(['docPrimaryMode', 'template', 'pageWidth']);

export const CREATABLE_PROPERTY_TYPES = ['text', 'number', 'checkbox', 'date'];

export class PropertyValueError extends Error {
  override name = 'PropertyValueError';
}

function toIsoDate(value: number | undefined | null) {
  return value ? new Date(value).toISOString() : null;
}

function normalizeValue(type: string, raw: unknown): string {
  const value = raw === null || raw === undefined ? '' : String(raw).trim();
  switch (type) {
    case 'text':
      return value;
    case 'number': {
      if (value === '') return '';
      const num = Number(value.replace(',', '.'));
      if (!Number.isFinite(num)) {
        throw new PropertyValueError(`"${value}" is not a number`);
      }
      return String(num);
    }
    case 'checkbox': {
      const lower = value.toLowerCase();
      if (['true', 'yes', '1', 'on', 'checked'].includes(lower)) return 'true';
      if (['false', 'no', '0', 'off', 'unchecked', ''].includes(lower)) {
        return 'false';
      }
      throw new PropertyValueError(`"${value}" is not true/false`);
    }
    case 'date': {
      if (value === '') return '';
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!match || Number.isNaN(Date.parse(`${match[0]}T00:00:00Z`))) {
        throw new PropertyValueError(
          `"${value}" is not a date in YYYY-MM-DD format`
        );
      }
      return match[0];
    }
    default:
      throw new PropertyValueError(`Properties of type ${type} cannot be set`);
  }
}

export function createLocalWorkspaceMeta(
  docsService: DocsService,
  tagService: TagService,
  propertyService: WorkspacePropertyService
): Pick<
  LocalWorkspaceContent,
  | 'listTags'
  | 'docsByTag'
  | 'listProperties'
  | 'getDocProperties'
  | 'setDocTags'
  | 'setDocProperty'
  | 'createProperty'
> {
  const tagList = tagService.tagList;

  const liveRecord = (docId: string) => {
    const record = docsService.list.doc$(docId).value;
    return record && !record.trash$.value ? record : null;
  };

  const docTitle = (docId: string) =>
    docsService.list.doc$(docId).value?.title$.value || 'Untitled';

  const findTag = (nameOrId: string) => {
    const wanted = nameOrId.trim().toLowerCase();
    return (
      tagList.tags$.value.find(tag => tag.id === nameOrId) ??
      tagList.tags$.value.find(
        tag => tag.value$.value.trim().toLowerCase() === wanted
      ) ??
      null
    );
  };

  const properties = (): LocalPropertyInfo[] =>
    propertyService.sortedProperties$.value
      .filter(info => !info.isDeleted)
      .map(info => {
        const builtIn = info.id in BUILT_IN_NAMES && info.id === info.type;
        return {
          id: info.id,
          name: info.name || BUILT_IN_NAMES[info.type] || info.type,
          type: info.type,
          builtIn,
          editable: builtIn
            ? EDITABLE_BUILT_INS.has(info.id) || info.id === 'tags'
            : EDITABLE_CUSTOM_TYPES.has(info.type),
        };
      });

  const findProperty = (nameOrId: string) => {
    const wanted = nameOrId.trim().toLowerCase();
    const list = properties();
    return (
      list.find(p => p.id === nameOrId) ??
      list.find(p => p.name.toLowerCase() === wanted) ??
      null
    );
  };

  const propertyValue = (
    record: NonNullable<ReturnType<typeof liveRecord>>,
    info: LocalPropertyInfo
  ): string | string[] | null => {
    const props = record.getProperties() as Record<string, unknown>;
    switch (info.id) {
      case 'tags':
        return tagList.tagsByPageId$(record.id).value.map(t => t.value$.value);
      case 'docPrimaryMode':
        return record.getPrimaryMode() ?? 'page';
      case 'template':
        return props.isTemplate ? 'true' : 'false';
      case 'pageWidth':
        return (props.pageWidth as string | undefined) ?? null;
      case 'journal':
        return (props.journal as string | undefined) ?? null;
      case 'createdAt':
        return toIsoDate(record.createdAt$.value);
      case 'updatedAt':
        return toIsoDate(record.updatedAt$.value);
      case 'createdBy':
      case 'updatedBy':
        return (props[info.id] as string | undefined) ?? null;
      case 'edgelessTheme':
        return (props.edgelessColorTheme as string | undefined) ?? null;
      default: {
        const value = props['custom:' + info.id];
        return value === undefined || value === null ? null : String(value);
      }
    }
  };

  return {
    async listTags() {
      return tagList.tags$.value
        .map(tag => ({
          id: tag.id,
          name: tag.value$.value,
          color: tag.color$.value,
          docCount: tag.pageIds$.value.filter(id => liveRecord(id)).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async docsByTag(nameOrId) {
      const tag = findTag(nameOrId);
      if (!tag) return null;
      return {
        tag: { id: tag.id, name: tag.value$.value },
        docs: tag.pageIds$.value
          .filter(id => liveRecord(id))
          .map(docId => ({ docId, title: docTitle(docId) })),
      };
    },

    async listProperties() {
      return properties();
    },

    async getDocProperties(docId) {
      const record = liveRecord(docId);
      if (!record) return null;
      return {
        docId,
        title: docTitle(docId),
        properties: properties().map(info => ({
          ...info,
          value: propertyValue(record, info),
        })),
      };
    },

    async setDocTags(docId, { add = [], remove = [] }) {
      const record = liveRecord(docId);
      if (!record) return null;
      const created: string[] = [];
      for (const name of add) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        let tag = findTag(trimmed);
        if (!tag) {
          tag = tagList.createTag(trimmed, tagService.randomTagColor());
          created.push(trimmed);
        }
        tag.tag(docId);
      }
      for (const name of remove) {
        findTag(name)?.untag(docId);
      }
      return {
        tags: tagList.tagsByPageId$(docId).value.map(t => t.value$.value),
        created,
      };
    },

    async setDocProperty(docId, property, rawValue) {
      const record = liveRecord(docId);
      if (!record) return null;
      const info = findProperty(property);
      if (!info) {
        throw new PropertyValueError(
          `Unknown property "${property}". Use property_list to see the available ones, or property_create to add one.`
        );
      }
      if (!info.editable || info.id === 'tags') {
        throw new PropertyValueError(
          info.id === 'tags'
            ? 'Use doc_set_tags to change tags.'
            : `"${info.name}" cannot be changed.`
        );
      }
      const value = String(rawValue ?? '').trim();
      switch (info.id) {
        case 'docPrimaryMode': {
          const mode = value.toLowerCase();
          if (mode !== 'page' && mode !== 'edgeless') {
            throw new PropertyValueError(
              'Doc mode must be "page" or "edgeless"'
            );
          }
          record.setPrimaryMode(mode);
          break;
        }
        case 'template':
          record.setProperty(
            'isTemplate',
            normalizeValue('checkbox', value) === 'true'
          );
          break;
        case 'pageWidth': {
          const width = value === 'full' ? 'fullWidth' : value;
          if (width !== 'standard' && width !== 'fullWidth') {
            throw new PropertyValueError(
              'Page width must be "standard" or "fullWidth"'
            );
          }
          record.setProperty('pageWidth', width);
          break;
        }
        default:
          record.setCustomProperty(info.id, normalizeValue(info.type, value));
      }
      return { ...info, value: propertyValue(record, info) };
    },

    async createProperty(name, type) {
      const trimmed = name.trim();
      if (!trimmed) throw new PropertyValueError('Property name is required');
      if (!CREATABLE_PROPERTY_TYPES.includes(type)) {
        throw new PropertyValueError(
          `Property type must be one of: ${CREATABLE_PROPERTY_TYPES.join(', ')}`
        );
      }
      const existing = findProperty(trimmed);
      if (existing) return { ...existing, existed: true };
      const created = propertyService.createProperty({
        name: trimmed,
        type: type as 'text',
        index: propertyService.indexAt('after'),
      });
      return {
        id: created.id,
        name: trimmed,
        type,
        builtIn: false,
        editable: true,
        existed: false,
      };
    },
  };
}
