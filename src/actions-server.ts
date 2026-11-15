import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { AmoClient } from "./amo-client.js";
import { summarizeLeads } from "./analytics.js";
import { loadConfig } from "./config.js";
import { leadFilters, toUnix } from "./query.js";

type Collection<T> = { _embedded?: Record<string, T[]>; _links?: { next?: { href?: string } } };
type Pipeline = { id: number; name: string; is_archive?: boolean; _embedded?: { statuses?: Array<{ id: number; name: string; sort?: number }> } };
type User = { id: number; name: string; rights?: { is_active?: boolean } };
type Lead = {
  id: number; name: string; price?: number; pipeline_id?: number; status_id?: number;
  responsible_user_id?: number; created_at?: number; updated_at?: number; closed_at?: number | null;
  custom_fields_values?: unknown[] | null;
};
type Task = { id: number; responsible_user_id?: number; entity_id?: number; entity_type?: string; is_completed?: boolean; complete_till?: number; text?: string; task_type_id?: number };

const config = loadConfig();
const amo = new AmoClient(config);
const apiKey = process.env.ACTIONS_API_KEY?.trim();
if (!apiKey || apiKey.length < 32) throw new Error("ACTIONS_API_KEY must contain at least 32 characters");

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const supplied = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!supplied || !secureEqual(supplied, apiKey!)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function iso(timestamp?: number | null) {
  return timestamp ? new Date(timestamp * 1000).toISOString() : null;
}

function positiveInt(value: unknown, fallback?: number, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) throw new Error("Expected a positive integer");
  return parsed;
}

function optionalBoolean(value: unknown, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error("Expected a boolean");
}

function filtersFromQuery(query: Request["query"]) {
  return {
    createdFrom: typeof query.createdFrom === "string" ? query.createdFrom : undefined,
    createdTo: typeof query.createdTo === "string" ? query.createdTo : undefined,
    updatedFrom: typeof query.updatedFrom === "string" ? query.updatedFrom : undefined,
    updatedTo: typeof query.updatedTo === "string" ? query.updatedTo : undefined,
    pipelineId: positiveInt(query.pipelineId),
    statusId: positiveInt(query.statusId),
    responsibleUserId: positiveInt(query.responsibleUserId),
  };
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

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.get(["/", "/health"], (_req, res) => res.json({ ok: true, service: "amocrm-readonly-actions" }));

app.get("/openapi.json", (_req, res) => res.json({
  openapi: "3.1.0",
  info: {
    title: "amoCRM Можем — read-only API",
    version: "1.0.0",
    description: "Безопасное чтение сделок, воронок, менеджеров и задач amoCRM. API не умеет изменять данные.",
  },
  servers: [{ url: "https://amocrm-readonly-mcp.fly.dev" }],
  security: [{ BearerAuth: [] }],
  components: {
    securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } },
    schemas: { Error: { type: "object", properties: { error: { type: "string" } } } },
  },
  paths: {
    "/api/account": { get: { operationId: "getAccount", summary: "Проверить подключённый аккаунт amoCRM", responses: { "200": { description: "Настройки аккаунта" } } } },
    "/api/pipelines": { get: { operationId: "listPipelines", summary: "Получить воронки и этапы", responses: { "200": { description: "Воронки amoCRM" } } } },
    "/api/users": { get: { operationId: "listUsers", summary: "Получить менеджеров", parameters: [{ name: "includeInactive", in: "query", schema: { type: "boolean", default: false } }], responses: { "200": { description: "Менеджеры без email" } } } },
    "/api/leads": { get: { operationId: "listLeads", summary: "Получить ограниченную выборку сделок", parameters: [
      { name: "createdFrom", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "createdTo", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "updatedFrom", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "updatedTo", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "pipelineId", in: "query", schema: { type: "integer" } },
      { name: "statusId", in: "query", schema: { type: "integer" } },
      { name: "responsibleUserId", in: "query", schema: { type: "integer" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
      { name: "includeCustomFields", in: "query", schema: { type: "boolean", default: false } },
    ], responses: { "200": { description: "Сделки без телефонов и email контактов" } } } },
    "/api/leads/{leadId}": { get: { operationId: "getLead", summary: "Получить одну сделку", parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Карточка сделки и ID связей" } } } },
    "/api/overview": { get: { operationId: "getCrmOverview", summary: "Получить агрегированный обзор воронки", parameters: [
      { name: "createdFrom", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "createdTo", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "updatedFrom", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "updatedTo", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "pipelineId", in: "query", schema: { type: "integer" } },
      { name: "statusId", in: "query", schema: { type: "integer" } },
      { name: "responsibleUserId", in: "query", schema: { type: "integer" } },
      { name: "maxLeads", in: "query", schema: { type: "integer", minimum: 1, maximum: 10000, default: 5000 } },
      { name: "staleDays", in: "query", schema: { type: "integer", minimum: 1, maximum: 365, default: 14 } },
    ], responses: { "200": { description: "Агрегаты по воронке и зависшим сделкам" } } } },
    "/api/tasks": { get: { operationId: "listTasks", summary: "Получить задачи amoCRM", parameters: [
      { name: "completed", in: "query", schema: { type: "boolean", default: false } },
      { name: "responsibleUserId", in: "query", schema: { type: "integer" } },
      { name: "leadId", in: "query", schema: { type: "integer" } },
      { name: "dueFrom", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "dueTo", in: "query", schema: { type: "string", format: "date-time" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
    ], responses: { "200": { description: "Ограниченная выборка задач" } } } },
    "/api/leads/{leadId}/stage-history": { get: { operationId: "getLeadStageHistory", summary: "Получить историю смены этапов сделки", parameters: [
      { name: "leadId", in: "path", required: true, schema: { type: "integer" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 250 } },
    ], responses: { "200": { description: "События смены этапов" } } } },
  },
}));

app.use("/api", authenticate);

app.get("/api/account", asyncRoute(async (_req, res) => {
  const account = await amo.get("/api/v4/account", new URLSearchParams({ with: "task_types,users_groups,datetime_settings" }));
  res.json(account);
}));

app.get("/api/pipelines", asyncRoute(async (_req, res) => {
  const response = await amo.get<Collection<Pipeline>>("/api/v4/leads/pipelines");
  res.json(response._embedded?.pipelines || []);
}));

app.get("/api/users", asyncRoute(async (req, res) => {
  const includeInactive = optionalBoolean(req.query.includeInactive, false);
  const users = await collect<User>("/api/v4/users", "users", new URLSearchParams(), 1000);
  res.json(users.filter(user => includeInactive || user.rights?.is_active !== false).map(user => ({ id: user.id, name: user.name, active: user.rights?.is_active ?? true })));
}));

app.get("/api/leads", asyncRoute(async (req, res) => {
  const limit = positiveInt(req.query.limit, 100, 500)!;
  const includeCustomFields = optionalBoolean(req.query.includeCustomFields, false);
  const leads = await collect<Lead>("/api/v4/leads", "leads", leadFilters(filtersFromQuery(req.query)), limit);
  res.json(leads.map(lead => ({
    id: lead.id, name: lead.name, price: lead.price || 0, pipeline_id: lead.pipeline_id,
    status_id: lead.status_id, responsible_user_id: lead.responsible_user_id,
    created_at: iso(lead.created_at), updated_at: iso(lead.updated_at), closed_at: iso(lead.closed_at),
    ...(includeCustomFields ? { custom_fields_values: lead.custom_fields_values || [] } : {}),
  })));
}));

app.get("/api/leads/:leadId", asyncRoute(async (req, res) => {
  const leadId = positiveInt(req.params.leadId)!;
  res.json(await amo.get(`/api/v4/leads/${leadId}`, new URLSearchParams({ with: "contacts,companies,loss_reason,source_id" })));
}));

app.get("/api/overview", asyncRoute(async (req, res) => {
  const filters = filtersFromQuery(req.query);
  const maxLeads = positiveInt(req.query.maxLeads, 5000, 10000)!;
  const staleDays = positiveInt(req.query.staleDays, 14, 365)!;
  const [pipelineResponse, leads] = await Promise.all([
    amo.get<Collection<Pipeline>>("/api/v4/leads/pipelines"),
    collect<Lead>("/api/v4/leads", "leads", leadFilters(filters), maxLeads),
  ]);
  res.json({ filters, truncated: leads.length >= maxLeads, ...summarizeLeads(leads, pipelineResponse._embedded?.pipelines || [], staleDays) });
}));

app.get("/api/tasks", asyncRoute(async (req, res) => {
  const completed = optionalBoolean(req.query.completed, false);
  const responsibleUserId = positiveInt(req.query.responsibleUserId);
  const leadId = positiveInt(req.query.leadId);
  const limit = positiveInt(req.query.limit, 100, 500)!;
  const params = new URLSearchParams({ "filter[is_completed]": completed ? "1" : "0" });
  if (responsibleUserId) params.set("filter[responsible_user_id]", String(responsibleUserId));
  if (leadId) { params.set("filter[entity_type]", "leads"); params.set("filter[entity_id]", String(leadId)); }
  const dueFrom = typeof req.query.dueFrom === "string" ? toUnix(req.query.dueFrom) : undefined;
  const dueTo = typeof req.query.dueTo === "string" ? toUnix(req.query.dueTo) : undefined;
  if (dueFrom) params.set("filter[complete_till][from]", String(dueFrom));
  if (dueTo) params.set("filter[complete_till][to]", String(dueTo));
  const tasks = await collect<Task>("/api/v4/tasks", "tasks", params, limit);
  res.json(tasks.map(task => ({ ...task, complete_till: iso(task.complete_till) })));
}));

app.get("/api/leads/:leadId/stage-history", asyncRoute(async (req, res) => {
  const leadId = positiveInt(req.params.leadId)!;
  const limit = positiveInt(req.query.limit, 250, 500)!;
  const params = new URLSearchParams({ "filter[entity]": "lead", "filter[entity_id]": String(leadId), "filter[type][]": "lead_status_changed" });
  res.json(await collect<Record<string, unknown>>("/api/v4/events", "events", params, limit));
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]"));
  if (/Expected|Invalid ISO date/.test(message)) res.status(400).json({ error: message });
  else res.status(502).json({ error: "amoCRM request failed" });
});

app.listen(config.port, config.host, () => {
  console.log(`amoCRM read-only Actions API listening at http://${config.host}:${config.port}`);
});
