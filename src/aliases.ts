import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolvePathToSource, resolveSafePath } from "./fs.js";
import type { SourceConfig } from "./types.js";

/** URL segment that holds every short link: `/s/<id>/<rest>`. */
export const ALIAS_NAMESPACE = "s";

/** Crockford base32, lowercase: no `i`, `l`, `o` or `u`. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

const MIN_ID_LENGTH = 8;

const VALID_ID = /^[0-9a-hjkmnp-tv-z]{8,}$/;

/** The slice of the table the HTTP routes read. */
export interface AliasResolver {
  resolve(id: string): SourceConfig | undefined;
}

/** The slice of the table `preview` writes. */
export interface AliasMinter {
  mint(directory: string): Promise<string>;
}

function base32(bytes: Buffer): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

/** A directory's full-length id; each prefix of it is a candidate id. */
function fullId(directory: string): string {
  return base32(createHash("sha256").update(directory).digest());
}

/**
 * Short links: each id names one directory, and `/s/<id>/<rest>` serves what
 * the directory's full path serves. The table lives in memory and in one JSON
 * file of id → directory, which every mint rewrites before it returns.
 *
 * Directories are stored lexically, in the configured root's spelling, so the
 * same directory hashes to the same id on each call.
 */
export class AliasTable implements AliasResolver, AliasMinter {
  private readonly byId = new Map<string, string>();
  private readonly byDirectory = new Map<string, string>();
  /** Serialises writes so a slower rename never lands an older table. */
  private writing: Promise<void> = Promise.resolve();
  private writeCount = 0;

  private constructor(
    private readonly file: string,
    private readonly sources: SourceConfig[],
  ) {}

  /**
   * Read the table file and drop each entry whose directory no longer passes
   * the admission check. A missing file is an empty table; a malformed one is
   * too, with a warning, so a bad file never stops the server.
   */
  static async load(file: string, sources: SourceConfig[]): Promise<AliasTable> {
    const table = new AliasTable(file, sources);
    const raw = await readTable(file);
    for (const [id, directory] of Object.entries(raw)) {
      if (
        !VALID_ID.test(id) ||
        typeof directory !== "string" ||
        path.resolve(directory) !== directory ||
        table.byDirectory.has(directory) ||
        !(await table.admits(directory))
      ) {
        continue;
      }
      table.add(id, directory);
    }
    return table;
  }

  resolve(id: string): SourceConfig | undefined {
    const root = this.byId.get(id);
    return root === undefined
      ? undefined
      : { prefix: `${ALIAS_NAMESPACE}/${id}`, root };
  }

  /**
   * The id for `directory`, minting and persisting one if it has none. The
   * id is the shortest prefix of the path's hash, eight characters or more,
   * that no other directory holds. Throws when the directory may not hold an
   * alias or the table cannot be written.
   */
  async mint(directory: string): Promise<string> {
    const lexical = path.resolve(directory);
    if (!(await this.admits(lexical))) {
      throw new Error(
        `"${directory}" is not a directory inside a configured source`,
      );
    }

    // No await between this lookup and `add`, so two concurrent mints for one
    // directory cannot both take an id.
    const existing = this.byDirectory.get(lexical);
    if (existing !== undefined) {
      // The mint that added it may still be writing the file.
      await this.writing;
      return existing;
    }

    const candidates = fullId(lexical);
    let length = MIN_ID_LENGTH;
    while (this.byId.has(candidates.slice(0, length))) {
      length++;
      if (length > candidates.length) {
        throw new Error(`No free short-link id for "${directory}"`);
      }
    }
    const id = candidates.slice(0, length);
    this.add(id, lexical);
    await this.persist();
    return id;
  }

  private add(id: string, directory: string) {
    this.byId.set(id, directory);
    this.byDirectory.set(directory, id);
  }

  /**
   * The one admission check: `directory` exists as a directory, is equal to
   * or inside a configured source, and passes the source's jail.
   */
  private async admits(directory: string): Promise<boolean> {
    if (!path.isAbsolute(directory)) return false;
    const match = resolvePathToSource(this.sources, directory);
    if (match === undefined) return false;
    try {
      const real = await resolveSafePath(match.source.root, match.relative);
      return (await stat(real)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Write the whole table: to a temp file, then rename over the old one, so a
   * reader never sees half a file. Each write snapshots the table when its
   * turn comes, so the last write always holds every entry.
   */
  private persist(): Promise<void> {
    const write = this.writing.then(async () => {
      const temp = `${this.file}.${process.pid}.${++this.writeCount}.tmp`;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(
        temp,
        JSON.stringify(Object.fromEntries(this.byId), null, 2) + "\n",
        "utf-8",
      );
      await rename(temp, this.file);
    });
    // A failed write fails its own mint, not the next one.
    this.writing = write.catch(() => {});
    return write;
  }
}

async function readTable(file: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    console.warn(`Warning: cannot read short links from ${file}: ${String(error)}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // reported below
  }
  console.warn(`Warning: ignoring malformed short-link table ${file}`);
  return {};
}
