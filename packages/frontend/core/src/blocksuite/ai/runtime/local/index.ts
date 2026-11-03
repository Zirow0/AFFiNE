import { CopilotClient } from '../request/copilot-client';
import { AIRequestService } from '../request/service';
import { LocalCopilotBackend, type LocalWorkspaceContent } from './backend';

export type { LocalWorkspaceContent } from './backend';
export { LocalCopilotBackend } from './backend';
export {
  listLocalAiKeys,
  LocalAiNotConfiguredError,
  resolveLocalModel,
} from './provider-config';

/**
 * Creates an {@link AIRequestService} that runs entirely on this device:
 * sessions are stored locally and requests go straight to the AI providers
 * configured in the desktop app. Used for local workspaces, which have no
 * server to talk to.
 */
export function createLocalAIRequestService(
  workspaceId: string,
  content?: LocalWorkspaceContent
) {
  const backend = new LocalCopilotBackend(workspaceId, content);
  return new AIRequestService(
    new CopilotClient(backend.gql, backend.eventSource),
    // documents of a local workspace are always available on this device
    async () => {}
  );
}
