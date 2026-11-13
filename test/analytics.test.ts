import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLeads } from "../src/analytics.js";

test("summarizes won, lost, open, stale and stage values", () => {
  const now = Date.UTC(2026, 9, 25);
  const summary = summarizeLeads([
    { id: 1, name: "Open", price: 100, pipeline_id: 10, status_id: 11, updated_at: Math.floor(now / 1000) },
    { id: 2, name: "Stale", price: 200, pipeline_id: 10, status_id: 11, updated_at: Math.floor(now / 1000) - 20 * 86400 },
    { id: 3, name: "Won", price: 300, pipeline_id: 10, status_id: 142, updated_at: Math.floor(now / 1000) },
    { id: 4, name: "Lost", price: 400, pipeline_id: 10, status_id: 143, updated_at: Math.floor(now / 1000) },
  ], [{ id: 10, name: "Main", _embedded: { statuses: [{ id: 11, name: "Qualified" }, { id: 142, name: "Won" }, { id: 143, name: "Lost" }] } }], 14, now);

  assert.equal(summary.leads, 4);
  assert.equal(summary.total_value, 1000);
  assert.equal(summary.open, 2);
  assert.equal(summary.won, 1);
  assert.equal(summary.lost, 1);
  assert.equal(summary.stale_open, 1);
  assert.deepEqual(summary.stages[0], { stage: "Main / Qualified", count: 2, value: 300 });
});
