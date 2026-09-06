import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";
export const ofapiMediaActions = {
  resume: (
    jobId: string,
    body: Parameters<typeof kernel.ofapiMediaUploadResume>[0]["body"],
  ) => kernel.ofapiMediaUploadResume({ params: { jobId }, body }),
  source: (body: Parameters<typeof kernel.ofapiMediaSourceCreate>[0]["body"]) =>
    kernel.ofapiMediaSourceCreate({ body }),
  upload: (body: Parameters<typeof kernel.ofapiMediaUploadCreate>[0]["body"]) =>
    kernel.ofapiMediaUploadCreate({ body }),
  handoff: (body: Parameters<typeof kernel.ofapiMediaHandoff>[0]["body"]) =>
    kernel.ofapiMediaHandoff({ body }),
  collect: (
    body: Parameters<typeof kernel.ofapiCollectionJobCreate>[0]["body"],
  ) => kernel.ofapiCollectionJobCreate({ body }),
};
export function useOfapiMedia(pageId: number, offset: number) {
  return useQuery({
    queryKey: ["ofapi", "media", pageId, offset],
    enabled: pageId > 0,
    queryFn: () =>
      kernel.ofapiMediaGet({ query: { pageId, offset, limit: 50 } }),
    refetchInterval: 15000,
  });
}
