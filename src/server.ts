import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";
import { AmoClient } from "./amo-client.js";
import { summarizeLeads } from "./analytics.js";
import { loadConfig } from "./config.js";
import { leadFilters, toUnix } from "./query.js";

type Collection<T> = { _embedded?: Record<string, T[]>; _links?: { next?: { href?: string } } };
type Pipeline = { id: number; name: string; is_archive?: boolean; _embedded?: { statuses?: Array<{ id: number; name: string; sort?: number }> } };
type User = { id: number; name: string; email?: string; rights?: { is_active?: boolean } };
type Lead = {
  id: number;
  name: string;
  price?: number;
  pipeline_id?: number;
  status_id?: number;
  responsible_user_id?: number;
  created_at?: number;
  updated_at?: number;
  closed_at?: number | null;
  custom_fields_values?: unknown[] | null;
  _embedded?: Record<string, unknown>;
};
type Task = { id: number; responsible_user_id?: number; entity_id?: number; entity_type?: string; is_completed?: boolean; complete_till?: number; text?: string; task_type_id?: number };

const config = loadConfig();
const amo = new AmoClient(config);

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function iso(timestamp?: number | null) {
  return timestamp ? new Date(timestamp * 1000).toISOString() : null;
}

async function collect<T>(pathName: string, key: string, params: URLSearchParams, maxItems: number): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  while (items.length < maxItems) {
    const query = new URLSearchParams(params);
    query.set("page", String(page));
    query.set("limit", String(Math.min(250, maxItems - items.length)));
    const response = await amo.get<Collection<T>>(pathName, query);
    const batch = response._embedded?.[key] || [];
    items.push(...batch);
    if (batch.length === 0 || !response._links?.next?.href) break;
    page += 1;
  }
  return items.slice(0, maxItems);
}

function createServer() {
  const server = new McpServer(
    { name: "amocrm-readonly", version: "0.1.0" },
    {
      instructions: "Read-only access to amoCRM for sales-funnel analysis. Never claim that this server can create, edit, delete, or message anything. Prefer crm_overview before requesting individual leads. Minimize personal data and use lead IDs when possible.",
    },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool("get_account", {
    title: "Get amoCRM account",
    description: "Use this to verify the connected amoCRM account and its basic settings.",
    inputSchema: {}, annotations: readOnly,
  }, async () => result(await amo.get("/api/v4/account", new URLSearchParams({ with: "task_types,users_groups,datetime_settings" }))));

  server.registerTool("list_pipelines", {
    title: "List sales pipelines",
    description: "Use this to map pipeline and stage IDs to names before analyzing leads.",
    inputSchema: {}, annotations: readOnly,
  }, async () => {
    const response = await amo.get<Collection<Pipeline>>("/api/v4/leads/pipelines");
    return result(response._embedded?.pipelines || []);
  });

  server.registerTool("list_users", {
    title: "List sales users",
    description: "Use this to map responsible-user IDs to manager names.",
    inputSchema: { includeInactive: z.boolean().optional().default(false) }, annotations: readOnly,
  }, async ({ includeInactive }) => {
    const users = await collect<User>("/api/v4/users", "users", new URLSearchParams(), 1000);
    return result(users.filter(u => includeInactive || u.rights?.is_active !== false).map(({ id, name, rights }) => ({ id, name, active: rights?.is_active ?? true })));
  });

  const leadFilterSchema = {
    createdFrom: z.string().optional().describe("ISO date/time, inclusive"),
    createdTo: z.string().optional().describe("ISO date/time, inclusive"),
    updatedFrom: z.string().optional().describe("ISO date/time, inclusive"),
    updatedTo: z.string().optional().describe("ISO date/time, inclusive"),
    pipelineId: z.number().int().positive().optional(),
    statusId: z.number().int().positive().optional(),
    responsibleUserId: z.number().int().positive().optional(),
  };

  server.registerTool("list_leads", {
    title: "List leads",
    description: "Use this for a bounded list of amoCRM leads. Results contain deal data, not contact phone numbers or emails.",
    inputSchema: {
      ...leadFilterSchema,
      limit: z.number().int().min(1).max(500).optional().default(100),
      includeCustomFields: z.boolean().optional().default(false),
    }, annotations: readOnly,
  }, async ({ limit, includeCustomFields, ...filters }) => {
    const leads = await collect<Lead>("/api/v4/leads", "leads", leadFilters(filters), limit);
    return result(leads.map(lead => ({
      id: lead.id, name: lead.name, price: lead.price || 0,
      pipeline_id: lead.pipeline_id, status_id: lead.status_id, responsible_user_id: lead.responsible_user_id,
      created_at: iso(lead.created_at), updated_at: iso(lead.updated_at), closed_at: iso(lead.closed_at),
      ...(includeCustomFields ? { custom_fields_values: lead.custom_fields_values || [] } : {}),
    })));
  });

  server.registerTool("get_lead", {
    title: "Get lead details",
    description: "Use this for one lead after identifying its ID. Returns deal details and linked entity IDs; it does not fetch contact phone numbers or emails.",
    inputSchema: { leadId: z.number().int().positive() }, annotations: readOnly,
  }, async ({ leadId }) => result(await amo.get(`/api/v4/leads/${leadId}`, new URLSearchParams({ with: "contacts,companies,loss_reason,source_id" }))));

  server.registerTool("crm_overview", {
    title: "Analyze funnel overview",
    description: "Use this first for an aggregate funnel snapshot by period: counts, value, open/won/lost, stale open leads, and distribution across stages. It omits contact personal data.",
    inputSchema: {
      ...leadFilterSchema,
      maxLeads: z.number().int().min(1).max(10000).optional().default(5000),
      staleDays: z.number().int().min(1).max(365).optional().default(14),
    }, annotations: readOnly,
  }, async ({ maxLeads, staleDays, ...filters }) => {
    const [pipelineResponse, leads] = await Promise.all([
      amo.get<Collection<Pipeline>>("/api/v4/leads/pipelines"),
      collect<Lead>("/api/v4/leads", "leads", leadFilters(filters), maxLeads),
    ]);
    const pipelines = pipelineResponse._embedded?.pipelines || [];
    return result({
      filters,
      truncated: leads.length >= maxLeads,
      ...summarizeLeads(leads, pipelines, staleDays),
    });
  });

  server.registerTool("list_tasks", {
    title: "List CRM tasks",
    description: "Use this to inspect incomplete, overdue, or lead-specific tasks. Results are bounded and read-only.",
    inputSchema: {
      completed: z.boolean().optional().default(false),
      responsibleUserId: z.number().int().positive().optional(),
      leadId: z.number().int().positive().optional(),
      dueFrom: z.string().optional().describe("ISO date/time"),
      dueTo: z.string().optional().describe("ISO date/time"),
      limit: z.number().int().min(1).max(500).optional().default(100),
    }, annotations: readOnly,
  }, async ({ completed, responsibleUserId, leadId, dueFrom, dueTo, limit }) => {
    const params = new URLSearchParams({ "filter[is_completed]": completed ? "1" : "0" });
    if (responsibleUserId) params.set("filter[responsible_user_id]", String(responsibleUserId));
    if (leadId) {
      params.set("filter[entity_type]", "leads");
      params.set("filter[entity_id]", String(leadId));
    }
    const from = toUnix(dueFrom); const to = toUnix(dueTo);
    if (from) params.set("filter[complete_till][from]", String(from));
    if (to) params.set("filter[complete_till][to]", String(to));
    const tasks = await collect<Task>("/api/v4/tasks", "tasks", params, limit);
    return result(tasks.map(task => ({ ...task, complete_till: iso(task.complete_till) })));
  });

  server.registerTool("lead_stage_history", {
    title: "Get lead stage history",
    description: "Use this to analyze when one lead changed pipeline stages and how long it spent between transitions.",
    inputSchema: { leadId: z.number().int().positive(), limit: z.number().int().min(1).max(500).optional().default(250) }, annotations: readOnly,
  }, async ({ leadId, limit }) => {
    const params = new URLSearchParams();
    params.set("filter[entity]", "lead");
    params.set("filter[entity_id]", String(leadId));
    params.set("filter[type][]", "lead_status_changed");
    const events = await collect<Record<string, unknown>>("/api/v4/events", "events", params, limit);
    return result(events);
  });

  return server;
}

const app = createMcpExpressApp({ host: config.host });
app.get("/health", (_req, res) => res.json({ ok: true, service: "amocrm-readonly-mcp" }));
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MCP request failed");
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  } finally {
    res.on("close", () => { void transport.close(); void server.close(); });
  }
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));

app.listen(config.port, config.host, () => {
  console.log(`amoCRM read-only MCP listening at http://${config.host}:${config.port}/mcp`);
});
