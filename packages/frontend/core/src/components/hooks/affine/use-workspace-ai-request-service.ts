import {
  type AIRequestService,
  createAIRequestService,
  createLocalAIRequestService,
  createLocalWorkspaceMeta,
} from '@affine/core/blocksuite/ai';
import { createLocalWorkspaceContent } from '@affine/core/blocksuite/ai/runtime/local/workspace-content';
import { EventSourceService, GraphQLService } from '@affine/core/modules/cloud';
import { DocsService } from '@affine/core/modules/doc';
import { DocsSearchService } from '@affine/core/modules/docs-search';
import { NbstoreService } from '@affine/core/modules/storage';
import { TagService } from '@affine/core/modules/tag';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { WorkspacePropertyService } from '@affine/core/modules/workspace-property';
import { useService } from '@toeverything/infra';
import { useMemo } from 'react';

/**
 * Whether AI for the current workspace runs on this device instead of a
 * server: local workspaces in the desktop app have no server to talk to.
 */
export function isOnDeviceAIWorkspace(workspace: { flavour: string }) {
  return BUILD_CONFIG.isElectron && workspace.flavour === 'local';
}

/**
 * The AI request service for the current workspace: the server copilot for
 * cloud/self-hosted workspaces, or the on-device backend that talks to the
 * user's own AI providers for local desktop workspaces.
 */
export function useWorkspaceAIRequestService(): AIRequestService {
  const graphqlService = useService(GraphQLService);
  const eventSourceService = useService(EventSourceService);
  const nbstoreService = useService(NbstoreService);
  const docsService = useService(DocsService);
  const docsSearchService = useService(DocsSearchService);
  const tagService = useService(TagService);
  const workspacePropertyService = useService(WorkspacePropertyService);
  const workspace = useService(WorkspaceService).workspace;

  return useMemo(() => {
    if (isOnDeviceAIWorkspace(workspace)) {
      return createLocalAIRequestService(
        workspace.id,
        createLocalWorkspaceContent(
          docsService,
          docsSearchService,
          blobId => workspace.engine.blob.get(blobId),
          createLocalWorkspaceMeta(
            docsService,
            tagService,
            workspacePropertyService
          )
        )
      );
    }
    return createAIRequestService(
      graphqlService.gql,
      eventSourceService.eventSource,
      nbstoreService.realtime,
      async docIds => {
        await Promise.all(
          [workspace.id, 'db$docProperties', ...docIds].map(docId =>
            workspace.engine.doc.waitForSynced(docId)
          )
        );
      }
    );
  }, [
    docsSearchService,
    docsService,
    eventSourceService,
    graphqlService,
    nbstoreService,
    tagService,
    workspace,
    workspacePropertyService,
  ]);
}
