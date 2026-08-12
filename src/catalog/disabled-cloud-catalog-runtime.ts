import type {
  CloudCatalogRuntime,
  CloudCatalogViewModel,
} from "./cloud-catalog-runtime";

const unavailableViewModel = (): CloudCatalogViewModel => ({
  status: "unavailable",
  source: "none",
  pdfCount: 0,
  verificationCounts: { unverified: 0, verified: 0, difference: 0, cloudMissing: 0 },
  query: "",
  folderPrefix: "",
  verificationStatuses: [],
  differenceKinds: [],
  topLevelGroupId: "",
  hierarchyTag: "",
  includeCloudMissing: false,
  groups: [],
  hierarchyTags: [],
  page: 0,
  pageSize: 50,
  total: 0,
  items: [],
  messageCode: "catalog-unavailable",
});

const rejectUnavailable = async (): Promise<void> => {
  throw new Error("catalog-unavailable");
};

export const DISABLED_CLOUD_CATALOG_RUNTIME: CloudCatalogRuntime = Object.freeze({
  initialize: async () => undefined,
  snapshot: unavailableViewModel,
  subscribe: () => () => undefined,
  setQuery: () => undefined,
  setFolderPrefix: () => undefined,
  setVerificationStatuses: () => undefined,
  setDifferenceKinds: () => undefined,
  setTopLevelGroupId: () => undefined,
  setHierarchyTag: () => undefined,
  setIncludeCloudMissing: () => undefined,
  setPage: () => undefined,
  copyFilename: rejectUnavailable,
  copyCloudPath: rejectUnavailable,
  openBaidu: rejectUnavailable,
  dispose: () => undefined,
});
