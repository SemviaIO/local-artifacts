import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AliasTable } from "./aliases.js";
import type { SourceConfig } from "./types.js";

const ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{8}$/;

describe("AliasTable", () => {
  let parent: string;
  let root: string;
  let outside: string;
  let sources: SourceConfig[];
  let tables = 0;

  /** A fresh table file path; nothing is written until the first mint. */
  const tableFile = () => path.join(parent, "tables", `${++tables}.json`);

  const readEntries = async (file: string) =>
    JSON.parse(await readFile(file, "utf-8")) as Record<string, string>;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), "local-artifacts-aliases-"));
    root = path.join(parent, "root");
    outside = path.join(parent, "outside");
    for (const dir of ["a", "b", "c", "d"]) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    await mkdir(outside);
    await writeFile(path.join(root, "a", "page.html"), "<h1>hi</h1>\n");
    await symlink(outside, path.join(root, "escape"));
    sources = [{ prefix: "plans", root }];
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("gives one directory the same eight-character id on each mint", async () => {
    const table = await AliasTable.load(tableFile(), sources);

    const first = await table.mint(path.join(root, "a"));
    const second = await table.mint(path.join(root, "a"));

    expect(first).toMatch(ID_SHAPE);
    expect(second).toBe(first);
  });

  it("derives the id from the path, not from the table", async () => {
    const one = await AliasTable.load(tableFile(), sources);
    const two = await AliasTable.load(tableFile(), sources);

    expect(await one.mint(path.join(root, "a"))).toBe(
      await two.mint(path.join(root, "a")),
    );
  });

  it("resolves an id to a source jailed at its directory", async () => {
    const table = await AliasTable.load(tableFile(), sources);
    const id = await table.mint(path.join(root, "a"));

    expect(table.resolve(id)).toEqual({ prefix: `s/${id}`, root: path.join(root, "a") });
    expect(table.resolve("zzzzzzzz")).toBeUndefined();
  });

  it("admits a source root", async () => {
    const table = await AliasTable.load(tableFile(), sources);

    expect(await table.mint(root)).toMatch(ID_SHAPE);
  });

  it("grows the later id by one character when two directories collide", async () => {
    const probe = await AliasTable.load(tableFile(), sources);
    const idOfB = await probe.mint(path.join(root, "b"));

    // Seed the table so directory A already holds B's eight-character id.
    const file = tableFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ [idOfB]: path.join(root, "a") }));
    const table = await AliasTable.load(file, sources);

    const grown = await table.mint(path.join(root, "b"));

    expect(grown).toHaveLength(9);
    expect(grown.startsWith(idOfB)).toBe(true);
    expect(table.resolve(idOfB)?.root).toBe(path.join(root, "a"));
    expect(table.resolve(grown)?.root).toBe(path.join(root, "b"));
  });

  it("keeps a minted id across a restart", async () => {
    const file = tableFile();
    const before = await AliasTable.load(file, sources);
    const id = await before.mint(path.join(root, "a"));

    const after = await AliasTable.load(file, sources);

    expect(after.resolve(id)?.root).toBe(path.join(root, "a"));
  });

  it("drops entries whose directory is gone or outside every source at load", async () => {
    const file = tableFile();
    const gone = path.join(root, "gone");
    await mkdir(gone);
    const before = await AliasTable.load(file, sources);
    const kept = await before.mint(path.join(root, "c"));
    const dropped = await before.mint(gone);
    await rm(gone, { recursive: true });
    const entries = await readEntries(file);
    entries["0000000000"] = outside;
    await writeFile(file, JSON.stringify(entries));

    const after = await AliasTable.load(file, sources);

    expect(after.resolve(kept)).toBeDefined();
    expect(after.resolve(dropped)).toBeUndefined();
    expect(after.resolve("0000000000")).toBeUndefined();
  });

  it("refuses a directory outside every source", async () => {
    const table = await AliasTable.load(tableFile(), sources);

    await expect(table.mint(outside)).rejects.toThrow(/not a directory inside a configured source/);
  });

  it("refuses a symlink in a source that points outside it", async () => {
    const table = await AliasTable.load(tableFile(), sources);

    await expect(table.mint(path.join(root, "escape"))).rejects.toThrow(
      /not a directory inside a configured source/,
    );
  });

  it("refuses a file", async () => {
    const table = await AliasTable.load(tableFile(), sources);

    await expect(table.mint(path.join(root, "a", "page.html"))).rejects.toThrow();
  });

  it("persists every entry when mints run together", async () => {
    const file = tableFile();
    const table = await AliasTable.load(file, sources);

    const ids = await Promise.all(
      ["a", "b", "c", "d"].map((dir) => table.mint(path.join(root, dir))),
    );

    expect(Object.keys(await readEntries(file)).sort()).toEqual([...ids].sort());
  });

  it("starts empty from a malformed file", async () => {
    const file = tableFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json");

    const table = await AliasTable.load(file, sources);

    expect(await table.mint(path.join(root, "a"))).toMatch(ID_SHAPE);
  });
});
