import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionUpsertedEvent } from '@/shared/types.js';

/**
 * The single producer of the `session_upserted` delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * It used to be built in two places — the on-disk sessions watcher and the
 * chat run registry — and only the registry's copy set `providerSessionId`.
 * That field is how the client notices a row it is showing has been merged
 * into its canonical app-session row, so a merge announced by any other path
 * left a stale duplicate in the sidebar. One builder, one shape.
 */
async function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
): Promise<SessionUpsertedEvent | null> {
  const envelope = await buildSessionUpsertEnvelope(sessionIdOrProviderSessionId);
  return envelope?.event ?? null;
}

/**
 * @internal Same as `buildSessionUpsertedEvent` but keeps the owning account
 * alongside the wire event, so per-user clients can be filtered without a
 * second DB lookup. Exported for the broadcast tests.
 */
export async function buildSessionUpsertEnvelope(
  sessionIdOrProviderSessionId: string,
): Promise<{ event: SessionUpsertedEvent; ownerId: number | null } | null> {
  // Resolving by provider id first covers the watcher, which only ever sees
  // the id written in the transcript. For a row where the two ids are equal
  // — legacy rows, and any session indexed from disk before its mapping
  // existed — both lookups land on the same row anyway.
  const row = sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId)
    ?? sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const event: SessionUpsertedEvent = {
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as SessionUpsertedEvent['provider'],
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  };

  return { event, ownerId: row.user_id == null ? null : Number(row.user_id) };
}

/**
 * Per-client delivery: an event with an owner only reaches that account's
 * sockets (tagged at connection time as `__wgUserId`). NULL-owned events
 * (legacy / disk-synced unattributed) broadcast to everyone as before.
 */
function sendToConnectedClients(
  envelopes: { payload: string; ownerId: number | null }[]
): void {
  if (envelopes.length === 0) {
    return;
  }

  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) {
      return;
    }
    const clientUserId = (client as { __wgUserId?: number | null }).__wgUserId;
    for (const { payload, ownerId } of envelopes) {
      if (ownerId != null && clientUserId != null && Number(ownerId) !== Number(clientUserId)) {
        continue;
      }
      client.send(payload);
    }
  });
}

/** Announces one session. Used by the chat run registry when a run reports its provider-native id. */
export async function broadcastSessionUpserted(sessionIdOrProviderSessionId: string): Promise<void> {
  const envelope = await buildSessionUpsertEnvelope(sessionIdOrProviderSessionId);
  if (envelope) {
    sendToConnectedClients([{ payload: JSON.stringify(envelope.event), ownerId: envelope.ownerId }]);
  }
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of ids at once — the client
 * set is walked once for the whole batch rather than once per session.
 */
export async function broadcastSessionUpsertedBatch(
  sessionIds: Iterable<string>,
): Promise<void> {
  const envelopes: { payload: string; ownerId: number | null }[] = [];
  for (const sessionId of sessionIds) {
    const envelope = await buildSessionUpsertEnvelope(sessionId);
    if (envelope) {
      envelopes.push({ payload: JSON.stringify(envelope.event), ownerId: envelope.ownerId });
    }
  }

  sendToConnectedClients(envelopes);
}

/** @internal Exported for the broadcast tests, which assert the payload shape directly. */
export { buildSessionUpsertedEvent };
