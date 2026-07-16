import { z } from "zod";

import { GitHubRepositoryReader } from "../../graph/github-repository-reader.js";
import { enqueueJobWithIdempotency } from "../../queue/enqueue.js";
import { createIdempotencyKey, createPayloadHash } from "../../queue/idempotency.js";
import {
  getRepoConfigsForInstallation,
  setInstallationRepoAccessState,
  transitionInstallationRepoAccessState,
  upsertRepoConfig,
} from "../../storage/repo-config-repo.js";
import { log } from "../../server/logger.js";

const installationPayloadSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
  }),
  repositories: z.array(z.object({ id: z.number() })).optional(),
  repository_selection: z.string().optional(),
});

interface InstallationEventContext {
  deliveryId: string;
  rawBody: string;
}

export async function handleInstallationEvent(payload: unknown, context: InstallationEventContext): Promise<void> {
  const parsed = installationPayloadSchema.parse(payload);
  const installationId = parsed.installation.id;

  switch (parsed.action) {
    case "created": {
      const repositoryIds = parsed.repositories?.map((repository) => repository.id) ?? [];
      const repositoryReader = new GitHubRepositoryReader();
      for (const repoId of repositoryIds) {
        const metadata = await repositoryReader.resolveRepository(repoId, installationId);
        await upsertRepoConfig({
          repoId,
          installationId,
          owner: metadata.owner,
          name: metadata.name,
          trackedBranch: metadata.defaultBranch,
          isActive: true,
          accessState: "active",
        });
      }
      await enqueueInstallationSync({
        deliveryId: context.deliveryId,
        rawBody: context.rawBody,
        eventAction: parsed.action,
        installationId,
        repositoryIds,
        repositorySelection: parsed.repository_selection,
      });
      log("info", "installation created", { deliveryId: context.deliveryId, installationId, repositoryCount: repositoryIds.length });
      return;
    }

    case "suspend": {
      const repositoryIds = await transitionInstallationRepoAccessState(installationId, "active", "suspended");
      log("info", "installation suspended", { deliveryId: context.deliveryId, installationId, repositoryCount: repositoryIds.length });
      return;
    }

    case "unsuspend": {
      const repositoryIds = await transitionInstallationRepoAccessState(installationId, "suspended", "active");
      await enqueueInstallationSync({
        deliveryId: context.deliveryId,
        rawBody: context.rawBody,
        eventAction: parsed.action,
        installationId,
        repositoryIds,
        repositorySelection: parsed.repository_selection,
      });
      log("info", "installation unsuspended", { deliveryId: context.deliveryId, installationId, repositoryCount: repositoryIds.length });
      return;
    }

    case "deleted": {
      const repositoryIds = await setInstallationRepoAccessState(installationId, "deleted");
      log("info", "installation deleted", { deliveryId: context.deliveryId, installationId, repositoryCount: repositoryIds.length });
      return;
    }

    case "new_permissions_accepted": {
      const repositoryIds = (await getRepoConfigsForInstallation(installationId))
        .filter((config) => config.isActive)
        .map((config) => config.repoId);
      await enqueueInstallationSync({
        deliveryId: context.deliveryId,
        rawBody: context.rawBody,
        eventAction: parsed.action,
        installationId,
        repositoryIds,
        repositorySelection: parsed.repository_selection,
      });
      log("info", "installation permissions accepted", {
        deliveryId: context.deliveryId,
        installationId,
        repositoryCount: repositoryIds.length,
      });
      return;
    }

    default:
      log("info", "installation action ignored", { deliveryId: context.deliveryId, installationId, action: parsed.action });
  }
}

async function enqueueInstallationSync(input: {
  deliveryId: string;
  rawBody: string;
  eventAction: string;
  installationId: number;
  repositoryIds: number[];
  repositorySelection?: string;
}): Promise<void> {
  await enqueueJobWithIdempotency({
    idempotencyKey: createIdempotencyKey({
      deliveryId: input.deliveryId,
      eventName: "installation",
      eventAction: input.eventAction,
      repoId: input.repositoryIds[0],
    }),
    deliveryId: input.deliveryId,
    eventName: "installation",
    eventAction: input.eventAction,
    repoId: input.repositoryIds[0],
    payloadSha256: createPayloadHash(input.rawBody),
    jobType: "installation.sync",
    jobPayload: {
      installationId: input.installationId,
      repositoryIds: input.repositoryIds,
      repositorySelection: input.repositorySelection ?? "selected",
      action: input.eventAction,
    },
  });
}
