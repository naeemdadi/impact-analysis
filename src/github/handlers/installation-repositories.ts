import { z } from "zod";

import { GitHubRepositoryReader } from "../../graph/github-repository-reader.js";
import { enqueueJobWithIdempotency } from "../../queue/enqueue.js";
import { createIdempotencyKey, createPayloadHash } from "../../queue/idempotency.js";
import { setRepoConfigAccessState, upsertRepoConfig } from "../../storage/repo-config-repo.js";
import { log } from "../../server/logger.js";

const installationRepositoriesPayloadSchema = z.object({
  action: z.enum(["added", "removed"]),
  installation: z.object({
    id: z.number(),
  }),
  repositories_added: z.array(
    z.object({
      id: z.number(),
    }),
  ),
  repositories_removed: z.array(
    z.object({
      id: z.number(),
    }),
  ),
  repository_selection: z.string().optional(),
});

interface InstallationRepositoriesEventContext {
  deliveryId: string;
  rawBody: string;
}

export async function handleInstallationRepositoriesEvent(
  payload: unknown,
  context: InstallationRepositoriesEventContext,
): Promise<void> {
  const parsed = installationRepositoriesPayloadSchema.parse(payload);

  if (parsed.action === "removed") {
    const repositoryIds = parsed.repositories_removed.map((repository) => repository.id);
    for (const repository of parsed.repositories_removed) {
      await setRepoConfigAccessState(repository.id, "removed");
    }
    await enqueueJobWithIdempotency({
      idempotencyKey: createIdempotencyKey({
        deliveryId: context.deliveryId,
        eventName: "installation_repositories",
        eventAction: parsed.action,
        repoId: repositoryIds[0],
      }),
      deliveryId: context.deliveryId,
      eventName: "installation_repositories",
      eventAction: parsed.action,
      repoId: repositoryIds[0],
      payloadSha256: createPayloadHash(context.rawBody),
      jobType: "installation.sync",
      jobPayload: {
        installationId: parsed.installation.id,
        repositoryIds,
        repositorySelection: parsed.repository_selection ?? "selected",
        action: parsed.action,
      },
    });
    log("info", "installation repositories removed", {
      deliveryId: context.deliveryId,
      installationId: parsed.installation.id,
      repositoryCount: repositoryIds.length,
    });
    return;
  }

  const repositoryReader = new GitHubRepositoryReader();
  for (const repository of parsed.repositories_added) {
    const metadata = await repositoryReader.resolveRepository(repository.id, parsed.installation.id);
    await upsertRepoConfig({
      repoId: repository.id,
      installationId: parsed.installation.id,
      owner: metadata.owner,
      name: metadata.name,
      trackedBranch: metadata.defaultBranch,
      isActive: true,
      accessState: "active",
    });
  }

  const repositoryIds = parsed.repositories_added.map((repository) => repository.id);
  await enqueueJobWithIdempotency({
    idempotencyKey: createIdempotencyKey({
      deliveryId: context.deliveryId,
      eventName: "installation_repositories",
      eventAction: parsed.action,
      repoId: repositoryIds[0],
    }),
    deliveryId: context.deliveryId,
    eventName: "installation_repositories",
    eventAction: parsed.action,
    repoId: repositoryIds[0],
    payloadSha256: createPayloadHash(context.rawBody),
    jobType: "installation.sync",
    jobPayload: {
      installationId: parsed.installation.id,
      repositoryIds,
      repositorySelection: parsed.repository_selection ?? "selected",
      action: parsed.action,
    },
  });

  log("info", "installation repositories added", {
    deliveryId: context.deliveryId,
    installationId: parsed.installation.id,
    repositoryCount: repositoryIds.length,
  });
}
