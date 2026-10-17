export declare function compareReleaseVersions(left: string, right: string): -1 | 0 | 1;
export declare function assertForwardRelease(args: {
  repository: string;
  tag: string;
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): Promise<void>;
