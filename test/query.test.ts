import assert from "node:assert/strict";
import test from "node:test";
import { leadFilters, toUnix } from "../src/query.js";

test("converts ISO timestamps and builds amoCRM nested filters", () => {
  assert.equal(toUnix("2026-10-25T00:00:00Z"), 1792886400);
  const query = leadFilters({
    createdFrom: "2026-10-01T00:00:00Z",
    pipelineId: 12,
    statusId: 34,
    responsibleUserId: 56,
  });
  assert.equal(query.get("filter[created_at][from]"), "1790812800");
  assert.equal(query.get("filter[statuses][0][pipeline_id]"), "12");
  assert.equal(query.get("filter[statuses][0][status_id]"), "34");
  assert.equal(query.get("filter[responsible_user_id]"), "56");
});

test("rejects invalid dates", () => {
  assert.throws(() => toUnix("not-a-date"), /Invalid ISO date/);
});
