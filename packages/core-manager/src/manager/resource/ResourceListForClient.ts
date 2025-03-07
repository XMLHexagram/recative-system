import debug from 'debug';
// @ts-ignore
import objectEntries from 'object.entries';

import {
  ResourceList,
  REDIRECT_URL_EXTENSION_ID,
  cleanUpResourceListForClient,
  IResourceFileForClient,
} from '@recative/definitions';
import { OpenPromise } from '@recative/open-promise';
import { getMatchedResource } from '@recative/smart-resource';
import type {
  IResourceItemForClient,
  IDetailedResourceItemForClient,
  IDetailedResourceGroupForClient,
} from '@recative/definitions';

import { selectUrl } from '../../utils/resource';
import { tryValidResourceUrl } from '../../utils/tryValidResourceUrl';
import type { PostProcessCallback } from '../../utils/tryValidResourceUrl';
import type { EpisodeCore } from '../../episodeCore';

const log = debug('core:resource-list');

const GLOBAL_CACHE = new Map<string, string | OpenPromise<string>>();

export enum PostProcessMagicWords {
  Metadata = 'Metadata',
  Url = 'Url',
}

export class ResourceListForClient extends ResourceList<IDetailedResourceItemForClient> {
  private cachedUrlMap: Map<string, string | OpenPromise<string>> = new Map();

  /**
   * ResourceListForClient will handle resource query related tasks, such as
   * query file by label or ID, query file by URL set and file description.
   *
   * This class will also handle resource fallback from different CDN and
   * resource convert related task.
   * @param rawResourceList Resource list generated by Studio.
   * @param core Core instance.
   * @param enableGlobalCache Cache resource URL that don't have a episode
   *        across core instances to boost preload performance.
   */
  constructor(
    public readonly rawResourceList: IResourceItemForClient[],
    private trustedUploaders: string[],
    private core: EpisodeCore,
    private enableGlobalCache = true,
  ) {
    super(cleanUpResourceListForClient(rawResourceList, true));
  }

  /**
   * Get resource by a URL map.
   * @param urlMap The key is the ID of the CDN or data source, the value is a
   *               URL.
   * @param postProcess Post process function, will convert the resource URL to
   *                    whatever you want. If the callback is not provided, this
   *                    method will return a URL, otherwise it will return the
   *                    result of the callback.
   * @param taskId Task ID for debug purpose, will only be shown in the debug log.
   * @returns A promise that resolves to the resource URL or post processed
   *          resource.
   */
  getResourceByUrlMap = async <
    Result = string,
    PostProcess extends
    | PostProcessCallback<Result, AdditionalData>
    | PostProcessMagicWords = PostProcessMagicWords.Url,
    AdditionalData = undefined,
    >(
    urlMap: Record<string, string>,
    postProcess?: PostProcess,
    additionalData?: AdditionalData,
    taskId = 'client-side-selector-url-map',
    addToGlobalCache = false,
    useSlowQueue = false,
  ): Promise<Result | null> => {
    if (postProcess === PostProcessMagicWords.Metadata) {
      throw new TypeError('getResourceByUrlMap can not return a resource metadata');
    }

    let finalUrlMap = urlMap;

    if (REDIRECT_URL_EXTENSION_ID in urlMap) {
      const nextId = urlMap[REDIRECT_URL_EXTENSION_ID]
        .replace('redirect://', '')
        .split('#')[0];
      const nextResource = await this.getResourceById<
      Result,
      PostProcessMagicWords.Metadata
      >(
        nextId,
        null,
        undefined,
        PostProcessMagicWords.Metadata,
        'file',
        useSlowQueue,
        taskId,
      );

      if (!nextResource) {
        throw new TypeError(`Resource ${nextId} not found.`);
      }

      if (nextResource.type === 'group') {
        throw new TypeError('Group in group is not allowed');
      }

      finalUrlMap = nextResource.url;
    }

    const encodedUrlMap = JSON.stringify(finalUrlMap);
    const cachedMap = addToGlobalCache ? this.cachedUrlMap : GLOBAL_CACHE;
    const cachedPromise = new OpenPromise<string>();

    // This function cache the url of try valid resource url.
    const wrappedPostProcess = (
      url: string,
      internalAdditionalData?: AdditionalData,
    ) => {
      cachedMap.set(encodedUrlMap, url);
      cachedPromise.resolve(url);

      if (postProcess && postProcess !== PostProcessMagicWords.Url) {
        return postProcess(url, internalAdditionalData);
      }

      cachedMap.set(encodedUrlMap, url);

      return url as unknown as Result;
    };

    // If the URL is cached.
    const cache = this.cachedUrlMap.get(encodedUrlMap)
                  ?? GLOBAL_CACHE.get(encodedUrlMap);
    if (cache) {
      return Promise.resolve(cache).then(
        (x) => wrappedPostProcess(x, additionalData),
      );
    }

    cachedMap.set(encodedUrlMap, cachedPromise);

    // If the URL is not cached.
    const task = new OpenPromise<Result | null>((resolve, reject) => {
      const reportTryTask = !!localStorage.getItem('@recative/core-manager/report-resource-validation');
      const logObject: Record<string, string> | undefined = reportTryTask ? {} : undefined;
      tryValidResourceUrl<
      PostProcessCallback<Result, AdditionalData>,
      Result,
      AdditionalData
      >(
        selectUrl(
          finalUrlMap,
          this.core.getEpisodeData()!.preferredUploaders,
          this.core.resolution.get(),
          logObject,
        ),
        wrappedPostProcess,
        additionalData,
        this.trustedUploaders,
        taskId,
        logObject,
      )
        .then(resolve)
        .catch(reject)
        .finally(() => {
          // Dump the log to console.
          if (reportTryTask) {
            const table = (objectEntries(logObject) as [string, string][])
              .map((x) => `${x[0]}\t${x[1]}`)
              .join('\r\n');

            const title = `${taskId}\r\n${new Array(taskId.length + 1).fill('=').join('')}\r\n\r\n`;
            const header = 'plugin\tstatus\tresult\r\n';
            const sep = '-------\t-------\t-------\r\n';

            log('Resource Report\r\n%s%s%s%s', title, header, sep, table);
          }
        });
    }, true);

    if (useSlowQueue) {
      this.core.slowTaskQueue.add(task, `slow-resource:${taskId}`);
    } else {
      this.core.fastTaskQueue.add(task, `fast-resource:${taskId}`);
    }

    return task.promise;
  };

  /**
   * Get resource by a resource description.
   * @param resource The resource description generated by Studio.
   * @param envConfig Environment variable, this value will be used if the
   *                  resource is a group, `smart-resource` will pick one file
   *                  from the group by the configuration.
   * @param weights Weight of each configuration.
   * @param postProcess Post process function, will convert the resource URL to
   *                    whatever you want. If the callback is not provided, this
   *                    method will return a URL, otherwise it will return the
   *                    result of the callback.
   * @param taskId Task ID for debug purpose, will only be shown in the debug log.
   * @returns A promise that resolves to the resource URL or post processed
   *          resource.
   */
  getResourceByResourceDescription = <
    Result = string,
    PostProcess extends
    | PostProcessCallback<Result, IResourceFileForClient>
    | PostProcessMagicWords = PostProcessMagicWords.Url,
  >(
    resource: IDetailedResourceItemForClient,
    envConfig: Record<string, string> | null = null,
    weights?: Record<string, number>,
    postProcess?: PostProcess,
    useSlowQueue = false,
    taskId = 'client-query',
  ):Promise<
  | null
  | (
    PostProcess extends PostProcessMagicWords.Metadata
      ? IDetailedResourceItemForClient
      : Result
  )
  > => {
    let finalResource: IDetailedResourceItemForClient | undefined;

    if (resource.type === 'group') {
      const trueEnvConfig = {
        ...this.core.envVariableManager.envVariableAtom.get().__smartResourceConfig,
        ...envConfig,
      };

      const matchedResource = getMatchedResource(
        resource.files.map((x) => ({
          item: x.id,
          selector: x.tags,
        })),
        trueEnvConfig,
        weights,
        taskId,
      );

      finalResource = this.filesById.get(matchedResource);
    } else {
      finalResource = this.filesById.get(resource.id);
    }

    if (!finalResource) {
      return Promise.resolve(null);
    }

    if (postProcess === PostProcessMagicWords.Metadata) {
      // type `PostProcess` is PostProcessMagicWords.Metadata now
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Promise.resolve(finalResource ?? null) as any;
    }

    const shouldCacheToGlobal = this.enableGlobalCache && (
      !finalResource.episodeIds.length
      || finalResource.cacheToHardDisk
    );

    // type `PostProcess` is not PostProcessMagicWords.Metadata now
    return this.getResourceByUrlMap<
    Result,
    PostProcess,
    IResourceFileForClient
    >(
      finalResource.url,
      postProcess,
      finalResource,
      taskId,
      shouldCacheToGlobal,
      useSlowQueue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
  };

  /**
   * Get resource by resource ID.
   * @param id The ID for the resource.
   * @param envConfig Environment variable, this value will be used if the
   *                  resource is a group, `smart-resource` will pick one file
   *                  from the group by the configuration.
   * @param weights Weight of each configuration.
   * @param postProcess Post process function, will convert the resource URL to
   *                    whatever you want. If the callback is not provided, this
   *                    method will return a URL, otherwise it will return the
   *                    result of the callback.
   * @param resourceType The resource is a group or file, if not provided, a
   *                     guessing strategy will be used.
   * @param taskId Task ID for debug purpose, will only be shown in the debug log.
   * @returns A promise that resolves to the resource URL or post processed
   *          resource.
   */
  getResourceById = <
    Result = string,
    PostProcess extends
    | PostProcessCallback<Result, IResourceFileForClient>
    | PostProcessMagicWords = PostProcessMagicWords.Url,
  >(
    id: string,
    envConfig: Record<string, string> | null = null,
    weights?: Record<string, number>,
    postProcess?: PostProcess,
    resourceType?: 'group' | 'file',
    useSlowQueue = false,
    taskId = `client-${id}`,
  ) => {
    const resource = this.queryItem(id, 'id', resourceType);

    if (!resource) return null;

    return this.getResourceByResourceDescription<
    Result,
    PostProcess
    >(
      resource,
      envConfig,
      weights,
      postProcess,
      useSlowQueue,
      taskId,
    );
  };

  private queryItem = (
    query: string,
    searchBy: 'label' | 'id',
    resourceType?: 'group' | 'file',
  ): IDetailedResourceItemForClient | undefined => {
    const group = (
      searchBy === 'label'
        ? this.groupsByLabel
        : this.groupsById
    ).get(query) as unknown as IDetailedResourceGroupForClient;
    const file = (
      searchBy === 'label'
        ? this.filesByLabel
        : this.filesById
    ).get(query);

    let result: IDetailedResourceItemForClient | undefined;

    switch (resourceType) {
      case 'group':
        result = group;
        break;
      case 'file':
        result = file;
        break;
      default:
        // Here's a resource query strategy:
        // * If we found a file and the file does not have a group, it will be
        //   selected;
        // * If we found a group, the group will be selected;
        // * Finally, the file within a group will be selected.
        if (file && !file.resourceGroupId) {
          result = file;
          break;
        }
        result = group ?? file;
    }

    if (result && 'redirectTo' in result && result.redirectTo) {
      return this.queryItem(result.redirectTo.split('#')[0], 'id', resourceType);
    }

    return result;
  };

  /**
   * Get resource by resource label.
   * @param label The label for the resource.
   * @param envConfig Environment variable, this value will be used if the
   *                  resource is a group, `smart-resource` will pick one file
   *                  from the group by the configuration.
   * @param weights Weight of each configuration.
   * @param postProcess Post process function, will convert the resource URL to
   *                    whatever you want. If the callback is not provided, this
   *                    method will return a URL, otherwise it will return the
   *                    result of the callback.
   * @param resourceType The resource is a group or file, if not provided, a
   *                     guessing strategy will be used.
   * @param taskId Task ID for debug purpose, will only be shown in the debug log.
   * @returns A promise that resolves to the resource URL or post processed
   *          resource.
   */
  getResourceByLabel = <
    Result = string,
    PostProcess extends
    | PostProcessCallback<Result, IResourceFileForClient>
    | PostProcessMagicWords = PostProcessMagicWords.Url,
  >(
    label: string,
    envConfig: Record<string, string> | null = null,
    weights?: Record<string, number>,
    postProcess?: PostProcess,
    resourceType?: 'group' | 'file',
    useSlowQueue = false,
    taskId = `client-${label}`,
  ) => {
    const resource = this.queryItem(label, 'label', resourceType);

    if (!resource) return null;

    return this.getResourceByResourceDescription<Result, PostProcess>(
      resource,
      envConfig,
      weights,
      postProcess,
      useSlowQueue,
      taskId,
    );
  };

  /**
   * Get resource by resource query.
   * @param label The object that indicate the query method.
   * @param envConfig Environment variable, this value will be used if the
   *                  resource is a group, `smart-resource` will pick one file
   *                  from the group by the configuration.
   * @param weights Weight of each configuration.
   * @param postProcess Post process function, will convert the resource URL to
   *                    whatever you want. If the callback is not provided, this
   *                    method will return a URL, otherwise it will return the
   *                    result of the callback.
   * @param resourceType The resource is a group or file, if not provided, a
   *                     guessing strategy will be used.
   * @param taskId Task ID for debug purpose, will only be shown in the debug log.
   * @returns A promise that resolves to the resource URL or post processed
   *          resource.
   */
  getResourceByQuery = <
    Result = string,
    PostProcess extends
    | PostProcessCallback<Result, IResourceFileForClient>
    | PostProcessMagicWords = PostProcessMagicWords.Url,
  >(
    query: string,
    queryType: 'label' | 'id',
    envConfig: Record<string, string> | null = null,
    weights?: Record<string, number>,
    postProcess?: PostProcess,
    resourceType?: 'group' | 'file',
    useSlowQueue = false,
    taskId = `client-${query}`,
  ) => {
    if (queryType === 'label') {
      return this.getResourceByLabel<Result, PostProcess>(
        query,
        envConfig,
        weights,
        postProcess,
        resourceType,
        useSlowQueue,
        taskId,
      );
    }
    return this.getResourceById<Result, PostProcess>(
      query,
      envConfig,
      weights,
      postProcess,
      resourceType,
      useSlowQueue,
      taskId,
    );
  };
}
