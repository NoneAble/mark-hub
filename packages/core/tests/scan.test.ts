import { describe, it, expect } from "vitest";
import {
  planFullScan,
  planIncrementalScan,
  collectSubtreeFolderIds,
} from "../src/scan";

describe("planFullScan", () => {
  it("marks new and missing", () => {
    const plan = planFullScan(
      [
        { id: "b1", url_normalized: "https://a.com", title: "A", folder_id: "f1", folder_path: "F" },
        { id: "b2", url_normalized: "https://b.com", title: "B", folder_id: "f1", folder_path: "F" },
      ],
      [
        { id: "a1", bookmark_id: "b1", present: true, status: "active" },
        { id: "a2", bookmark_id: "b3", present: true, status: "pending" },
      ],
    );
    expect(plan.upserts).toHaveLength(2);
    expect(plan.upserts.find((u) => u.bookmark_id === "b1")?.is_new).toBe(false);
    expect(plan.upserts.find((u) => u.bookmark_id === "b2")?.is_new).toBe(true);
    expect(plan.missing_annotation_ids).toEqual(["a2"]);
  });
});

describe("planIncrementalScan", () => {
  it("falls back when no watermark", () => {
    expect(planIncrementalScan([], null).mode).toBe("full_fallback");
  });

  it("filters relevant entity types", () => {
    const plan = planIncrementalScan(
      [
        { id: 1, entity_type: "bookmark", entity_id: "b", action: "update" },
        { id: 2, entity_type: "tag", entity_id: "t", action: "create" },
        { id: 3, entity_type: "folder", entity_id: "f", action: "delete" },
      ],
      0,
    );
    expect(plan.mode).toBe("incremental");
    expect(plan.relevant.map((r) => r.id)).toEqual([1, 3]);
    expect(plan.new_cursor).toBe(3);
  });
});

describe("collectSubtreeFolderIds", () => {
  it("walks children", () => {
    const set = collectSubtreeFolderIds(
      ["r"],
      [
        { id: "r", parent_id: null },
        { id: "c1", parent_id: "r" },
        { id: "c2", parent_id: "c1" },
        { id: "other", parent_id: null },
      ],
    );
    expect([...set].sort()).toEqual(["c1", "c2", "r"]);
  });
});
