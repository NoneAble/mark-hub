import { describe, expect, it } from "vitest";
import {
  decodeFolderPathKey,
  encodeFolderPathKey,
  folderIdentityMetaFromExport,
  folderPathMetaFromExport,
  folderPathsFromExport,
  importParseRejection,
  normalizeTagNames,
  parseCsv,
  parseJsonExport,
  parseNetscapeHtml,
  validateImportOptions,
} from "../src/importParse.js";

describe("parseJsonExport native MarkHub schema (RQG-BACKUP-001)", () => {
  it("resolves folder_id via folders[] and accepts tag objects + favorite flags", () => {
    const payload = {
      format: "markhub-json",
      version: 1,
      folders: [
        { id: "inbox", name: "Inbox", parent_id: null, is_system: 1 },
        { id: "f1", name: "Work", parent_id: null, is_system: 0 },
        { id: "f2", name: "Deep", parent_id: "f1", is_system: 0 },
      ],
      bookmarks: [
        {
          title: "Nested",
          url: "https://backup.example/nested",
          folder_id: "f2",
          tags: [{ id: "t1", name: "alpha" }, { name: "beta" }],
          visibility: "public",
          is_favorite: 1,
          is_archived: true,
        },
      ],
    };
    const parsed = parseJsonExport(JSON.stringify(payload));
    expect(parsed.errors).toEqual([]);
    expect(parsed.bookmarks).toHaveLength(1);
    const b = parsed.bookmarks[0]!;
    expect(b.folder_path).toEqual(["Work", "Deep"]);
    expect(b.tags).toEqual(["alpha", "beta"]);
    expect(b.is_favorite).toBe(true);
    expect(b.is_archived).toBe(true);
    expect(b.visibility).toBe("public");
  });

  it("preserves nested folder visibility in folder_meta (RQG-BACKUP-001)", () => {
    // Failure mode: importer used only path strings and defaulted every folder to private.
    const payload = {
      format: "markhub-json",
      version: 1,
      folders: [
        {
          id: "inbox",
          name: "Inbox",
          parent_id: null,
          is_system: true,
          visibility: "private",
        },
        {
          id: "pub",
          name: "PublicRoot",
          parent_id: null,
          is_system: false,
          visibility: "public",
        },
        {
          id: "nested",
          name: "NestedPrivate",
          parent_id: "pub",
          is_system: false,
          visibility: "private",
        },
        {
          id: "unl",
          name: "UnlistedLeaf",
          parent_id: "nested",
          is_system: false,
          visibility: "unlisted",
        },
      ],
      bookmarks: [
        {
          title: "Nav",
          url: "https://backup.example/nav",
          folder_id: "unl",
          visibility: "public",
        },
      ],
    };
    const parsed = parseJsonExport(JSON.stringify(payload));
    expect(parsed.errors).toEqual([]);
    expect(
      parsed.folder_meta.get(encodeFolderPathKey(["PublicRoot"]))?.visibility,
    ).toBe("public");
    expect(
      parsed.folder_meta.get(
        encodeFolderPathKey(["PublicRoot", "NestedPrivate"]),
      )?.visibility,
    ).toBe("private");
    expect(
      parsed.folder_meta.get(
        encodeFolderPathKey(["PublicRoot", "NestedPrivate", "UnlistedLeaf"]),
      )?.visibility,
    ).toBe("unlisted");
    // folders[] paths are listed even when bookmarks only reference the leaf
    expect(parsed.folders).toEqual(
      expect.arrayContaining([
        ["PublicRoot"],
        ["PublicRoot", "NestedPrivate"],
        ["PublicRoot", "NestedPrivate", "UnlistedLeaf"],
      ]),
    );
  });

  it("preserves folder names containing path separators (RQG-BACKUP-001)", () => {
    // Failure mode: slash-joined keys + split('/') turn "A/B" → folders A and B.
    const payload = {
      format: "markhub-json",
      version: 1,
      folders: [
        { id: "inbox", name: "Inbox", parent_id: null, is_system: true },
        {
          id: "slash",
          name: "A/B",
          parent_id: null,
          is_system: false,
          visibility: "public",
        },
        {
          id: "child",
          name: "C",
          parent_id: "slash",
          is_system: false,
          visibility: "private",
        },
        {
          id: "empty",
          name: "Empty/Leaf",
          parent_id: null,
          is_system: false,
          visibility: "unlisted",
        },
      ],
      bookmarks: [
        {
          title: "Under slash parent",
          url: "https://backup.example/slash-name",
          folder_id: "child",
          folder_path: ["A/B", "C"],
          visibility: "public",
        },
      ],
    };
    const parsed = parseJsonExport(JSON.stringify(payload));
    expect(parsed.errors).toEqual([]);
    expect(parsed.bookmarks[0]!.folder_path).toEqual(["A/B", "C"]);
    // Encoded keys must NOT collapse to ["A","B","C"]
    expect(
      parsed.folder_meta.get(encodeFolderPathKey(["A/B"]))?.visibility,
    ).toBe("public");
    expect(
      parsed.folder_meta.get(encodeFolderPathKey(["A/B", "C"]))?.visibility,
    ).toBe("private");
    expect(
      parsed.folder_meta.get(encodeFolderPathKey(["Empty/Leaf"]))?.visibility,
    ).toBe("unlisted");
    // Must not invent intermediate "A" / "B" segments
    expect(parsed.folder_meta.has(encodeFolderPathKey(["A"]))).toBe(false);
    expect(parsed.folder_meta.has(encodeFolderPathKey(["A", "B"]))).toBe(false);
    expect(parsed.folders).toEqual(
      expect.arrayContaining([
        ["A/B"],
        ["A/B", "C"],
        ["Empty/Leaf"],
      ]),
    );
    // Empty folder (no bookmark) still present
    expect(
      parsed.folders.some(
        (p) => p.length === 1 && p[0] === "Empty/Leaf",
      ),
    ).toBe(true);
  });

  it("encode/decodeFolderPathKey round-trips segments with separators", () => {
    const segs = ["A/B", "C\\D", "E"];
    const key = encodeFolderPathKey(segs);
    expect(decodeFolderPathKey(key)).toEqual(segs);
    // Distinct from nested A → B
    expect(encodeFolderPathKey(["A", "B"])).not.toBe(
      encodeFolderPathKey(["A/B"]),
    );
  });

  it("normalizeTagNames handles mixed shapes", () => {
    expect(normalizeTagNames([{ name: "a" }, "b", { name: "" }, 1])).toEqual(["a", "b"]);
    expect(normalizeTagNames("x, y")).toEqual(["x", "y"]);
  });

  it("folderPathsFromExport skips system folders", () => {
    const paths = folderPathsFromExport([
      { id: "inbox", name: "Inbox", parent_id: null, is_system: true },
      { id: "f1", name: "A", parent_id: null, is_system: false },
    ]);
    expect(paths.get("inbox")).toEqual([]);
    expect(paths.get("f1")).toEqual(["A"]);
  });

  it("folderPathMetaFromExport maps path keys to visibility", () => {
    const meta = folderPathMetaFromExport([
      { id: "f1", name: "A", parent_id: null, is_system: false, visibility: "public" },
      {
        id: "f2",
        name: "B",
        parent_id: "f1",
        is_system: false,
        visibility: "unlisted",
      },
    ]);
    expect(meta.get(encodeFolderPathKey(["A"]))?.visibility).toBe("public");
    expect(meta.get(encodeFolderPathKey(["A", "B"]))?.visibility).toBe(
      "unlisted",
    );
  });

  it("preserves duplicate folder identities via folder_by_export_id (RQG-F003)", () => {
    const payload = {
      format: "markhub-json",
      version: 1,
      folders: [
        {
          id: "d1",
          name: "Dup",
          parent_id: null,
          is_system: false,
          visibility: "public",
          sort_order: 0,
        },
        {
          id: "d2",
          name: "Dup",
          parent_id: null,
          is_system: false,
          visibility: "private",
          sort_order: 1,
        },
      ],
      bookmarks: [
        {
          title: "A",
          url: "https://backup.example/a",
          folder_id: "d1",
        },
        {
          title: "B",
          url: "https://backup.example/b",
          folder_id: "d2",
        },
      ],
      tags: [{ id: "t1", name: "orphan", color: "#abc" }],
    };
    const parsed = parseJsonExport(JSON.stringify(payload));
    expect(parsed.errors).toEqual([]);
    expect(parsed.folder_by_export_id.size).toBe(2);
    expect(parsed.folder_by_export_id.get("d1")?.visibility).toBe("public");
    expect(parsed.folder_by_export_id.get("d2")?.visibility).toBe("private");
    expect(parsed.bookmarks[0]!.export_folder_id).toBe("d1");
    expect(parsed.bookmarks[1]!.export_folder_id).toBe("d2");
    expect(parsed.tags).toEqual([
      { name: "orphan", color: "#abc", export_id: "t1" },
    ]);
    // Path meta collapses to one key, identity map does not
    expect(folderIdentityMetaFromExport(payload.folders).size).toBe(2);
  });

  it("rejects unknown native version and partial errors (RQG-F008)", () => {
    const badVer = parseJsonExport(
      JSON.stringify({
        format: "markhub-json",
        version: 99,
        bookmarks: [{ title: "x", url: "https://e.example" }],
      }),
    );
    expect(importParseRejection(badVer)).toMatch(/version/i);

    const partial = parseJsonExport(
      JSON.stringify({
        format: "markhub-json",
        version: 1,
        bookmarks: [
          { title: "ok", url: "https://e.example/ok" },
          { title: "bad", url: "" },
        ],
      }),
    );
    expect(partial.bookmarks).toHaveLength(1);
    expect(importParseRejection(partial)).toMatch(/missing url/i);

    const csv = parseCsv("title,url\nGood,https://e.example\nBad,\n");
    expect(importParseRejection(csv)).toMatch(/missing url/i);

    const opts = validateImportOptions({
      format: "yaml",
      strategy: "explode",
    });
    expect(opts.errors.length).toBe(2);
  });

  it("parses HTML visibility/tag extensions (RQG-F003)", () => {
    const html = `
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 DATA-VISIBILITY="public" DATA-SORT-ORDER="1">Pub</H3>
    <DL><p>
        <DT><A HREF="https://html.example/x" DATA-VISIBILITY="unlisted" DATA-FAVORITE="true" TAGS="a,b" DATA-SORT-ORDER="3">X</A>
    </DL><p>
</DL><p>
`;
    const parsed = parseNetscapeHtml(html);
    expect(importParseRejection(parsed)).toBeNull();
    expect(parsed.folder_meta.get(encodeFolderPathKey(["Pub"]))?.visibility).toBe(
      "public",
    );
    expect(parsed.bookmarks[0]!.visibility).toBe("unlisted");
    expect(parsed.bookmarks[0]!.is_favorite).toBe(true);
    expect(parsed.bookmarks[0]!.tags).toEqual(["a", "b"]);
    expect(parsed.bookmarks[0]!.sort_order).toBe(3);
  });

  it("parses CSV folder_path JSON column (RQG-F003)", () => {
    const csv = [
      "title,url,folder_path,folder_visibility,sort_order",
      'N,https://csv.example/n,"[""Root"",""Child""]",unlisted,2',
    ].join("\n");
    const parsed = parseCsv(csv);
    expect(importParseRejection(parsed)).toBeNull();
    expect(parsed.bookmarks[0]!.folder_path).toEqual(["Root", "Child"]);
    expect(
      parsed.folder_meta.get(encodeFolderPathKey(["Root", "Child"]))?.visibility,
    ).toBe("unlisted");
    expect(parsed.bookmarks[0]!.sort_order).toBe(2);
  });
});
