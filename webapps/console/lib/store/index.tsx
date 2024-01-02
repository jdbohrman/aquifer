import type { DestinationConfig, FunctionConfig, ServiceConfig, StreamConfig } from "../schema";
import { useEffect, useState } from "react";
import { getLog, requireDefined, rpc } from "juava";
import { useWorkspace } from "../context";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ConfigurationObjectLinkDbModel, WorkspaceDbModel } from "../../prisma/schema";
import { UseMutationResult } from "@tanstack/react-query/src/types";

export const allConfigTypes = ["stream", "service", "function", "destination"] as const;

export type ConfigType = (typeof allConfigTypes)[number];

export type ConfigTypes = {
  stream: StreamConfig;
  service: ServiceConfig;
  function: FunctionConfig;
  destination: DestinationConfig;
};

export function asConfigType(type: string): ConfigType {
  if (!allConfigTypes.includes(type as any)) {
    throw new Error(`Unknown config type ${type}`);
  }
  return type as ConfigType;
}

export type Result<T> =
  | {
      isLoading: true;
      data?: never;
      error?: never;
    }
  | { isLoading: false; data: T; error?: never }
  | { isLoading: false; data?: never; error: Error };

export function useConfigObject<T extends ConfigType>(type: T, id: string): ConfigTypes[T] | undefined {
  const list = useConfigObjectList(type);
  return list.find(o => o.id === id);
}

export function getConfigObjectCacheKey(workspaceId: string, type: ConfigType) {
  return [`workspaceId=${workspaceId}`, "config-object-type", type];
}

export function getLinksCacheKey(workspaceId: string, opts?: UseConfigObjectLinksParams) {
  //so far we have one store that always contains data, so withData is always true. We remove data
  //further from hook result. It's just a placeholder for future optimization
  return [`workspaceId=${workspaceId}`, "links", "withData=true"];
}

type UseConfigObjectsUpdaterResult = { loading: true; error?: never } | { loading: false; error: Error };

function toError(e: any) {
  return e instanceof Error ? e : new Error(e?.message || "Unknown error");
}

function getWorkspaceCacheKey(workspaceIdOrSlug: string) {
  return ["workspace", workspaceIdOrSlug];
}

async function initialDataLoad(workspaceIdOrSlug: string, queryClient: QueryClient): Promise<{ workspaceId: string }> {
  const loaders: Promise<void>[] = [];
  const cachingOptions = {
    retry: false,
    staleTime: Infinity,
    cacheTime: Infinity,
    //initialData: []
  };


  await queryClient.prefetchQuery(
    getWorkspaceCacheKey(workspaceIdOrSlug),
    async ({ signal }) =>
      WorkspaceDbModel.parse(await rpc(`/api/workspace/${workspaceIdOrSlug}`, { signal })),
    cachingOptions
  );
  const workspace = requireDefined(
    queryClient.getQueryData(getWorkspaceCacheKey(workspaceIdOrSlug)),
    `No data for workspace ${workspaceIdOrSlug} was prefetched`
  ) as z.infer<typeof WorkspaceDbModel>;

  for (const type of allConfigTypes) {
    loaders.push(
      queryClient.prefetchQuery(getConfigObjectCacheKey(workspace.id, type), async ({ signal }) => {
        getLog().atDebug().log(`/api/${workspace.id}/config/${type}`);
        const { objects } = await rpc(`/api/${workspace.id}/config/${type}`, { signal });
        getLog().atDebug().log(`Loaded ${objects.length} config objects of type ${type}`);
        return objects;
      }, cachingOptions)
    );
  }
  loaders.push(
    queryClient.prefetchQuery(getLinksCacheKey(workspace.id), async ({ signal }) => {
      const { links } = await rpc(`/api/${workspace.id}/config/link`, { signal });
      getLog().atDebug().log(`Loaded ${links.length} config links`);
      return links;
    }, cachingOptions)
  );
  await Promise.all(loaders);
  return { workspaceId: workspace.id };
}

function fullDataRefresh(workspaceId: string, queryClient: QueryClient) {
  const loaders: Promise<void>[] = [];
  for (const type of allConfigTypes) {
    loaders.push(
      rpc(`/api/${workspaceId}/config/${type}`).then(({ objects }) => {
        getLog().atDebug().log(`Refreshed ${objects.length} config objects of type ${type}`);
        queryClient.setQueriesData(getConfigObjectCacheKey(workspaceId, type), objects);
      })
    );
  }
  loaders.push(
    rpc(`/api/${workspaceId}/config/link`).then(({ links }) => {
      getLog().atDebug().log(`Refreshed ${links.length} config links`);
      queryClient.setQueriesData(getLinksCacheKey(workspaceId), links);
    })
  );
  return loaders;
}

export function useLoadedWorkspace(workspaceIdOrSlug: string): z.infer<typeof WorkspaceDbModel> | undefined {
  const queryClient = useQueryClient();
  return queryClient.getQueryData(getWorkspaceCacheKey(workspaceIdOrSlug)) as z.infer<typeof WorkspaceDbModel>;
}

/**
 * This method loads all config object and stores them in a cache. Subsequent calls useConfigObjectList() will be
 * non-blocking and return the cached data.
 *
 * It also sets up a background task to update the cache.
 *
 * And it provides a method to signal an update to the cache.
 */
export function useConfigObjectsUpdater(workspaceIdOrSlug: string): UseConfigObjectsUpdaterResult {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | undefined>();
  useEffect(() => {
    const abortController = new AbortController();
    let isMounted = true;
    let modifiedSince = new Date();
    //reload data after every 5 seconds;
    initialDataLoad(workspaceIdOrSlug, queryClient)
      .then(res => {
        getLog().atDebug().log("Initial version of workspace config has been loaded");
        const interval = setInterval(async () => {
          if (!isMounted) {
            clearInterval(interval);
          } else {
            const ifModified = await rpc(`/api/${res.workspaceId}/if-modified`, {
              query: { since: modifiedSince.toISOString() },
            });
            if (ifModified.modified) {
              modifiedSince = new Date();
              getLog().atDebug().log("Workspace config has been modified, reloading");
              try {
                await Promise.all(fullDataRefresh(res.workspaceId, queryClient));
              } catch (e) {
                getLog().atWarn().log("Failed to refresh workspace config", e);
              }
            } else {
              //getLog().atDebug().log("No changes in workspace config");
            }
          }
        }, 5000);
      })
      .catch(setError)
      .finally(() => setLoading(false));

    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [queryClient, workspaceIdOrSlug]);

  return loading ? { loading: true } : { loading: false, error: error! };
}

type UseConfigObjectLinksParams = { withData?: boolean; type?: "push" | "sync" };

type ConfigurationObjectLinkType = z.infer<typeof ConfigurationObjectLinkDbModel>;
type UseConfigObjetLinkResult = Omit<ConfigurationObjectLinkType, "data"> & { data?: any };

export function useConfigObjectLinksLoader(opts?: UseConfigObjectLinksParams): Result<UseConfigObjetLinkResult[]> {
  const workspace = useWorkspace();
  const queryRes = useQuery(getLinksCacheKey(workspace.id, opts), noopLoader, {
    retry: false,
    staleTime: Infinity,
    cacheTime: Infinity,
  });
  //reserved for future use, due to noopLoader, the loading will be always false
  if (queryRes.isLoading) {
    return { isLoading: true };
  } else if (queryRes.error) {
    return { isLoading: false, error: toError(queryRes.error) };
  } else {
    return {
      isLoading: false,
      data: (queryRes.data! as UseConfigObjetLinkResult[]).filter(link => !opts?.type || link.type === opts?.type),
    };
  }
}

/**
 * Indicates that data in the store has been updated and should be reloaded
 *
 * `opts` reserved for future use, if we ever need to support partial reloads.
 *
 * The usage is as follows:
 *
 * ```ts
 * const reloadStore = useStoreReload();
 *
 * const save = useCallback(async () => {
 *  try {
 *    await postDataToServer();
 *    await reloadStore();
 *  } catch (e) {
 *     //handle error
 *  } finally {
 *     setLoading(false);
 *  }
 * }), []);
 *
 * Alternatively, you can use useConfigObjectMutation() w
 */
export function useStoreReload(): (opts?: {}) => Promise<void> {
  const queryClient = useQueryClient();
  const workspace = useWorkspace();
  return async () => {
    await Promise.all(fullDataRefresh(workspace.id, queryClient));
  };
}

export function useConfigObjectLinks(opts?: UseConfigObjectLinksParams): UseConfigObjetLinkResult[] {
  const loader = useConfigObjectLinksLoader(opts);
  if (loader.isLoading) {
    throw new Error(
      "useConfigObjectLinks() assumes that all config objects are already loaded, but they are loading. use useConfigObjectListLoader() instead."
    );
  } else if (loader.error) {
    throw loader.error;
  }
  return loader.data;
}

/**
 * For useQuery where data should be inserted externally, so the loader should never be called
 */
export function noopLoader() {
  throw new Error("The loader should not be called");
}

export function useConfigObjectListLoader<T extends ConfigType>(type: T): Result<ConfigTypes[T][]> {
  const workspace = useWorkspace();
  const queryRes = useQuery(getConfigObjectCacheKey(workspace.id, type), noopLoader, {
    retry: false,
    staleTime: Infinity,
    cacheTime: Infinity,
  });
  //reserved for future use, due to noopLoader, the loading will be always false
  if (queryRes.isLoading) {
    return { isLoading: true };
  } else if (queryRes.error) {
    return { isLoading: false, error: toError(queryRes.error) };
  } else {
    return { isLoading: false, data: queryRes.data! };
  }
}

export function useConfigObjectListIfAvailable<T extends ConfigType>(type: T): ConfigTypes[T][] | undefined {
  const loader = useConfigObjectListLoader(type);
  return !loader.isLoading && !loader.error ? loader.data : undefined;
}

export function useConfigObjectList<T extends ConfigType>(type: T): ConfigTypes[T][] {
  const loader = useConfigObjectListLoader(type);
  if (loader.isLoading) {
    throw new Error(
      `useConfigObjectList() assumes that instance of ${type} is already loaded, but it is loading. use useConfigObjectListLoader() instead.`
    );
  }
  if (loader.error) {
    throw loader.error;
  }
  return loader.data;
}

export function useConfigObjectMutation<FParams = unknown>(
  type: ConfigType,
  fn: (variables: FParams) => Promise<void>
): UseMutationResult<unknown, Error, FParams> {
  const queryClient = useQueryClient();
  const workspace = useWorkspace();
  return useMutation<unknown, Error, FParams, unknown>(async params => {
    try {
      await fn(params);
      queryClient.setQueriesData(
        getConfigObjectCacheKey(workspace.id, type),
        (await rpc(`/api/${workspace.id}/config/${type}`)).objects
      );
    } catch (e) {
      throw toError(e);
    }
  });
}

export function useConfigObjectLinkMutation<FParams = unknown>(
  fn: (variables: FParams) => Promise<void>
): UseMutationResult<unknown, Error, FParams> {
  const queryClient = useQueryClient();
  const workspace = useWorkspace();
  return useMutation<unknown, Error, FParams, unknown>(async params => {
    try {
      await fn(params);
      queryClient.setQueriesData(getLinksCacheKey(workspace.id), (await rpc(`/api/${workspace.id}/link`)).links);
    } catch (e) {
      throw toError(e);
    }
  });
}
