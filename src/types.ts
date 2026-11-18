/**
 * Listing entry — discriminated union so consumers can only access
 * `size` after narrowing on `kind === "file"`.
 *
 * `path` is always posix-style (forward slashes), relative to the
 * configured source root.
 */
export type FileEntry =
  | {
      kind: "file";
      name: string;
      path: string;
      modified: string;
      size: number;
    }
  | {
      kind: "dir";
      name: string;
      path: string;
      modified: string;
    };

export interface SourceConfig {
  /** URL path prefix, e.g. "plans" or "claude/plans". */
  prefix: string;
  /** Filesystem directory. */
  root: string;
  /**
   * When true, the source is served (routes register, `preview` resolves) but
   * is omitted from MCP tool descriptions, `list_paths`, and the browser root
   * index. The built-in `claude-sessions` source is the exception: its root
   * is named in the MCP instructions and the `preview` description. Use for fallback directories you want available by absolute-path
   * lookup without advertising them.
   */
  hidden?: boolean;
}

/**
 * Where a set of source routes is mounted, and how a request finds the
 * source it reads. A configured source mounts at `/<prefix>` and always finds
 * itself; short links mount once at `/s/:id` and look the id up, so a link
 * minted after startup serves with no new route.
 */
export interface SourceRoute {
  /** URL pattern of the source root, with no trailing slash, e.g. `/plans`. */
  pattern: string;
  lookup: (params: Record<string, string>) => SourceConfig | undefined;
}

export interface Config {
  sources: SourceConfig[];
  port: number;
  host: string;
  tailscale: boolean;
  /**
   * Resolved at startup from a MagicDNS reverse lookup when tailscale is
   * enabled. The host guard in `createApp` reads it per request, so assigning
   * it after `listen()` admits the tailnet hostname from then on.
   */
  tailscaleUrl?: string;
}
