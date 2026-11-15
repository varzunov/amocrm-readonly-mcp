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
if (!apiKey || apiKey.length < 20) throw new Error("ACTIONS_API_KEY must contain at least 20 characters");
const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
const openaiModel = process.env.OPENAI_MODEL?.trim() || "gpt-6-luna";
const sessionValue = crypto.createHmac("sha256", apiKey).update("amocrm-analyst-session-v1").digest("hex");

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") || "";
  const supplied = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const cookie = (req.header("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith("amocrm_session="))?.slice("amocrm_session=".length) || "";
  const validBearer = Boolean(supplied && secureEqual(supplied, apiKey!));
  const validSession = Boolean(cookie && secureEqual(cookie, sessionValue));
  if (!validBearer && !validSession) {
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
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get(["/", "/health"], (_req, res) => res.json({ ok: true, service: "amocrm-readonly-actions" }));

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
app.post("/login", (req, res) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const record = loginAttempts.get(ip);
  const current = !record || record.resetAt < now ? { count: 0, resetAt: now + 15 * 60_000 } : record;
  if (current.count >= 10) {
    res.status(429).json({ error: "Слишком много попыток. Попробуйте через 15 минут." });
    return;
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!secureEqual(password, apiKey!)) {
    current.count += 1;
    loginAttempts.set(ip, current);
    res.status(401).json({ error: "Неверный пароль" });
    return;
  }
  loginAttempts.delete(ip);
  res.setHeader("Set-Cookie", `amocrm_session=${sessionValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
  res.json({ ok: true });
});

const webAppHtml = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Аналитик amoCRM — Можем</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,sans-serif;color:#172033;background:#f4f6fa}
*{box-sizing:border-box}body{margin:0}.shell{max-width:900px;margin:auto;min-height:100vh;padding:20px}
.card{background:#fff;border:1px solid #e3e7ef;border-radius:18px;box-shadow:0 12px 35px #263a5c14}
header{display:flex;align-items:center;gap:14px;padding:18px 20px}.logo{width:44px;height:44px;border-radius:13px;background:#6941c6;color:#fff;display:grid;place-items:center;font-weight:800}
h1{font-size:20px;margin:0}.sub{font-size:13px;color:#697386;margin-top:3px}.status{margin-left:auto;color:#157f3d;font-size:13px}
#login{max-width:430px;margin:12vh auto 0;padding:28px}#login h2{margin:0 0 8px}#login p{color:#697386}
input,textarea,button{font:inherit}input{width:100%;padding:13px 14px;border:1px solid #cfd5df;border-radius:11px}
button{border:0;border-radius:11px;padding:12px 17px;background:#6941c6;color:white;font-weight:650;cursor:pointer}
#login button{width:100%;margin-top:12px}.error{color:#b42318;font-size:13px;margin-top:10px}
#chat{display:none}.messages{height:calc(100vh - 230px);min-height:420px;overflow:auto;padding:10px 18px 25px}
.msg{max-width:82%;padding:13px 15px;border-radius:16px;margin:10px 0;white-space:pre-wrap;line-height:1.47}
.user{margin-left:auto;background:#6941c6;color:white;border-bottom-right-radius:5px}
.assistant{background:#f0f2f6;border-bottom-left-radius:5px}.thinking{color:#697386}
.composer{display:flex;gap:10px;padding:14px;border-top:1px solid #e3e7ef}.composer textarea{flex:1;resize:none;border:1px solid #cfd5df;border-radius:12px;padding:12px;min-height:48px;max-height:140px}
.controls{padding:0 18px 12px}.period{display:flex;align-items:center;gap:8px;margin-bottom:10px;color:#697386;font-size:13px}.period select{border:1px solid #cfd5df;border-radius:9px;padding:7px 10px;background:white;color:#172033}
.suggestions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.suggestions button{background:#eee9fb;color:#5630aa;padding:9px 10px;font-size:13px;text-align:left}
@media(max-width:600px){.shell{padding:0}.card{border-radius:0;border-left:0;border-right:0}.messages{height:calc(100vh - 315px);min-height:330px}.msg{max-width:92%}.status{display:none}.suggestions{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="shell">
<section id="login" class="card"><h2>Аналитик amoCRM</h2><p>Введите сохранённый пароль «amoCRM GPT API».</p><input id="password" type="password" autocomplete="current-password" placeholder="Пароль"><button id="loginBtn">Войти</button><div id="loginError" class="error"></div></section>
<section id="chat" class="card">
<header><div class="logo">М</div><div><h1>Аналитик amoCRM</h1><div class="sub">Проект «Можем» · только чтение данных</div></div><div class="status">● подключено</div></header>
<div class="controls"><div class="period"><label for="period">Период анализа:</label><select id="period"><option value="7">7 дней</option><option value="30" selected>30 дней</option><option value="90">90 дней</option><option value="all">Всё время</option></select></div>
<div class="suggestions"><button data-q="Подготовь руководительский обзор: динамика, ключевые цифры, отклонения и приоритеты">Обзор руководителя</button><button data-q="Найди узкие места и основные проблемы воронки">Проблемы воронки</button><button data-q="Покажи зависшие сделки, начиная с самых важных, и предложи действие по каждой">Зависшие сделки</button><button data-q="Сравни работу менеджеров с учётом нагрузки, открытых, успешных и зависших сделок">Работа менеджеров</button><button data-q="Покажи просроченные задачи, ответственных и приоритет действий">Просроченные задачи</button><button data-q="Проанализируй проигранные сделки и возможные причины потерь">Потери и отказы</button></div></div>
<div id="messages" class="messages"><div class="msg assistant">Здравствуйте, Андрей. Я могу анализировать воронки, сделки, менеджеров и задачи в amoCRM. Данные не изменяю.</div></div>
<form id="composer" class="composer"><textarea id="prompt" placeholder="Например: что происходит с воронкой за последний месяц?"></textarea><button>Отправить</button></form>
</section></div>
<script>
const login=document.querySelector('#login'),chat=document.querySelector('#chat'),messages=document.querySelector('#messages'),prompt=document.querySelector('#prompt'),period=document.querySelector('#period');
const history=[]; const add=(text,role)=>{const d=document.createElement('div');d.className='msg '+role;d.textContent=text;messages.appendChild(d);messages.scrollTop=messages.scrollHeight;return d};
async function signIn(){const error=document.querySelector('#loginError');error.textContent='';const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});if(!r.ok){error.textContent=(await r.json()).error||'Ошибка входа';return}login.style.display='none';chat.style.display='block'}
document.querySelector('#loginBtn').onclick=signIn;document.querySelector('#password').addEventListener('keydown',e=>{if(e.key==='Enter')signIn()});
function withPeriod(q){if(period.value==='all')return q+'\nПериод: всё доступное время. Явно укажи это ограничение.';const days=Number(period.value);const to=new Date();const from=new Date(to.getTime()-days*86400000);return q+'\nПериод анализа: с '+from.toISOString()+' по '+to.toISOString()+' ('+days+' дней). Используй эти даты в фильтрах CRM.'}
async function ask(q){if(!q.trim())return;const display=q;const enriched=withPeriod(q);add(display,'user');history.push({role:'user',content:enriched});prompt.value='';const started=Date.now();const wait=add('Анализирую данные amoCRM… обычно это занимает 15–40 секунд.','assistant thinking');const ticker=setInterval(()=>{wait.textContent='Анализирую данные amoCRM… '+Math.floor((Date.now()-started)/1000)+' сек.'},1000);try{const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:history.slice(-12)})});const data=await r.json();clearInterval(ticker);wait.remove();if(!r.ok)throw new Error(data.error||'Ошибка запроса');add(data.answer,'assistant');history.push({role:'assistant',content:data.answer})}catch(e){clearInterval(ticker);wait.textContent='Ошибка: '+e.message;wait.classList.remove('thinking')}}
document.querySelector('#composer').addEventListener('submit',e=>{e.preventDefault();ask(prompt.value)});document.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>ask(b.dataset.q));
fetch('/api/account').then(r=>{if(r.ok){login.style.display='none';chat.style.display='block'}}).catch(()=>{});
</script></body></html>`;

app.get("/app", (_req, res) => res.type("html").send(webAppHtml));

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

const crmTools = [
  { type: "function", name: "get_account", description: "Проверить подключённый аккаунт amoCRM.", strict: false, parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "list_pipelines", description: "Получить воронки и этапы, чтобы сопоставить ID с названиями.", strict: false, parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "list_users", description: "Получить активных менеджеров без email и телефонов.", strict: false, parameters: { type: "object", properties: { includeInactive: { type: "boolean" } }, additionalProperties: false } },
  { type: "function", name: "list_leads", description: "Получить ограниченную выборку сделок без телефонов и email контактов.", strict: false, parameters: { type: "object", properties: {
    createdFrom: { type: "string", description: "ISO дата/время" }, createdTo: { type: "string", description: "ISO дата/время" },
    updatedFrom: { type: "string", description: "ISO дата/время" }, updatedTo: { type: "string", description: "ISO дата/время" },
    pipelineId: { type: "integer" }, statusId: { type: "integer" }, responsibleUserId: { type: "integer" },
    limit: { type: "integer", minimum: 1, maximum: 500 },
  }, additionalProperties: false } },
  { type: "function", name: "get_lead", description: "Получить карточку одной сделки по ID и связанные сущности.", strict: false, parameters: { type: "object", properties: { leadId: { type: "integer" } }, required: ["leadId"], additionalProperties: false } },
  { type: "function", name: "crm_overview", description: "Основной инструмент: агрегированный обзор воронки, открытых, выигранных, проигранных и зависших сделок.", strict: false, parameters: { type: "object", properties: {
    createdFrom: { type: "string", description: "ISO дата/время" }, createdTo: { type: "string", description: "ISO дата/время" },
    updatedFrom: { type: "string", description: "ISO дата/время" }, updatedTo: { type: "string", description: "ISO дата/время" },
    pipelineId: { type: "integer" }, statusId: { type: "integer" }, responsibleUserId: { type: "integer" },
    maxLeads: { type: "integer", minimum: 1, maximum: 10000 }, staleDays: { type: "integer", minimum: 1, maximum: 365 },
  }, additionalProperties: false } },
  { type: "function", name: "list_tasks", description: "Получить незавершённые, просроченные или связанные со сделкой задачи.", strict: false, parameters: { type: "object", properties: {
    completed: { type: "boolean" }, responsibleUserId: { type: "integer" }, leadId: { type: "integer" },
    dueFrom: { type: "string", description: "ISO дата/время" }, dueTo: { type: "string", description: "ISO дата/время" },
    limit: { type: "integer", minimum: 1, maximum: 500 },
  }, additionalProperties: false } },
  { type: "function", name: "lead_stage_history", description: "Получить историю смены этапов одной сделки.", strict: false, parameters: { type: "object", properties: { leadId: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["leadId"], additionalProperties: false } },
];

async function executeCrmTool(name: string, args: Record<string, unknown>) {
  if (name === "get_account") return amo.get("/api/v4/account", new URLSearchParams({ with: "task_types,users_groups,datetime_settings" }));
  if (name === "list_pipelines") {
    const response = await amo.get<Collection<Pipeline>>("/api/v4/leads/pipelines");
    return response._embedded?.pipelines || [];
  }
  if (name === "list_users") {
    const users = await collect<User>("/api/v4/users", "users", new URLSearchParams(), 1000);
    const includeInactive = Boolean(args.includeInactive);
    return users.filter(user => includeInactive || user.rights?.is_active !== false).map(user => ({ id: user.id, name: user.name, active: user.rights?.is_active ?? true }));
  }
  if (name === "list_leads") {
    const limit = positiveInt(args.limit, 100, 500)!;
    const filters = {
      createdFrom: typeof args.createdFrom === "string" ? args.createdFrom : undefined,
      createdTo: typeof args.createdTo === "string" ? args.createdTo : undefined,
      updatedFrom: typeof args.updatedFrom === "string" ? args.updatedFrom : undefined,
      updatedTo: typeof args.updatedTo === "string" ? args.updatedTo : undefined,
      pipelineId: positiveInt(args.pipelineId), statusId: positiveInt(args.statusId), responsibleUserId: positiveInt(args.responsibleUserId),
    };
    const leads = await collect<Lead>("/api/v4/leads", "leads", leadFilters(filters), limit);
    return leads.map(lead => ({ id: lead.id, name: lead.name, price: lead.price || 0, pipeline_id: lead.pipeline_id, status_id: lead.status_id, responsible_user_id: lead.responsible_user_id, created_at: iso(lead.created_at), updated_at: iso(lead.updated_at), closed_at: iso(lead.closed_at) }));
  }
  if (name === "get_lead") {
    const leadId = positiveInt(args.leadId)!;
    return amo.get(`/api/v4/leads/${leadId}`, new URLSearchParams({ with: "contacts,companies,loss_reason,source_id" }));
  }
  if (name === "crm_overview") {
    const filters = {
      createdFrom: typeof args.createdFrom === "string" ? args.createdFrom : undefined,
      createdTo: typeof args.createdTo === "string" ? args.createdTo : undefined,
      updatedFrom: typeof args.updatedFrom === "string" ? args.updatedFrom : undefined,
      updatedTo: typeof args.updatedTo === "string" ? args.updatedTo : undefined,
      pipelineId: positiveInt(args.pipelineId), statusId: positiveInt(args.statusId), responsibleUserId: positiveInt(args.responsibleUserId),
    };
    const maxLeads = positiveInt(args.maxLeads, 5000, 10000)!;
    const staleDays = positiveInt(args.staleDays, 14, 365)!;
    const [pipelineResponse, leads] = await Promise.all([
      amo.get<Collection<Pipeline>>("/api/v4/leads/pipelines"),
      collect<Lead>("/api/v4/leads", "leads", leadFilters(filters), maxLeads),
    ]);
    return { filters, truncated: leads.length >= maxLeads, ...summarizeLeads(leads, pipelineResponse._embedded?.pipelines || [], staleDays) };
  }
  if (name === "list_tasks") {
    const params = new URLSearchParams({ "filter[is_completed]": args.completed ? "1" : "0" });
    const responsibleUserId = positiveInt(args.responsibleUserId);
    const leadId = positiveInt(args.leadId);
    if (responsibleUserId) params.set("filter[responsible_user_id]", String(responsibleUserId));
    if (leadId) { params.set("filter[entity_type]", "leads"); params.set("filter[entity_id]", String(leadId)); }
    const dueFrom = typeof args.dueFrom === "string" ? toUnix(args.dueFrom) : undefined;
    const dueTo = typeof args.dueTo === "string" ? toUnix(args.dueTo) : undefined;
    if (dueFrom) params.set("filter[complete_till][from]", String(dueFrom));
    if (dueTo) params.set("filter[complete_till][to]", String(dueTo));
    const tasks = await collect<Task>("/api/v4/tasks", "tasks", params, positiveInt(args.limit, 100, 500)!);
    return tasks.map(task => ({ ...task, complete_till: iso(task.complete_till) }));
  }
  if (name === "lead_stage_history") {
    const leadId = positiveInt(args.leadId)!;
    const params = new URLSearchParams({ "filter[entity]": "lead", "filter[entity_id]": String(leadId), "filter[type][]": "lead_status_changed" });
    return collect<Record<string, unknown>>("/api/v4/events", "events", params, positiveInt(args.limit, 250, 500)!);
  }
  throw new Error("Unknown CRM tool");
}

function responseText(response: any) {
  return (response.output || []).flatMap((item: any) => item.type === "message" ? item.content || [] : []).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("\n").trim();
}

app.post("/api/chat", asyncRoute(async (req, res) => {
  if (!openaiApiKey) {
    res.status(503).json({ error: "OPENAI_API_KEY ещё не настроен" });
    return;
  }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!messages.length || messages.some((message: any) => !["user", "assistant"].includes(message?.role) || typeof message?.content !== "string" || message.content.length > 8000)) {
    res.status(400).json({ error: "Некорректное сообщение" });
    return;
  }
  let input: any[] = messages.map((message: any) => ({ role: message.role, content: message.content }));
  let finalText = "";
  for (let round = 0; round < 8; round += 1) {
    const apiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: openaiModel,
        store: false,
        include: ["reasoning.encrypted_content"],
        instructions: `Ты — старший аналитик продаж проекта «Можем». Отвечай по-русски, конкретно и управленчески. Используй только предоставленные инструменты amoCRM и никогда не выдумывай данные. Для любого анализа сначала вызови crm_overview с указанным пользователем периодом; если период не указан — используй последние 30 дней и явно скажи об этом. Для названий этапов используй list_pipelines, для имён ответственных — list_users. Не показывай голые ID, если можешь получить название. Для зависших сделок используй stale_leads из crm_overview; зависшая сделка — открытая сделка без обновления дольше staleDays. Не называй сумму всех статусов прогнозом выручки. При сравнении менеджеров учитывай разную нагрузку и качество входящих лидов, не делай категоричных выводов только по числу побед. Если данных для вывода недостаточно — прямо скажи, каких полей не хватает. Формат ответа: 1) краткий вывод в 2–4 предложениях; 2) ключевые цифры; 3) проблемы и отклонения; 4) конкретные сделки или ответственные, если применимо; 5) 3–7 приоритетных действий; 6) ограничения данных. Валюта аккаунта RUB, отображай суммы в ₽. Доступ строго read-only: не обещай изменять данные. Сегодня: ${new Date().toISOString().slice(0, 10)}.`,
        input,
        tools: crmTools,
        max_output_tokens: 3000,
      }),
    });
    const payload: any = await apiResponse.json();
    if (!apiResponse.ok) throw new Error(`OpenAI API error ${apiResponse.status}: ${payload?.error?.message || "unknown"}`);
    const calls = (payload.output || []).filter((item: any) => item.type === "function_call");
    finalText = responseText(payload);
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
      try {
        const toolResult = await executeCrmTool(call.name, args);
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(toolResult) });
      } catch (error) {
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: error instanceof Error ? error.message : "CRM tool failed" }) });
      }
    }
    input = [...input, ...(payload.output || []), ...outputs];
  }
  if (!finalText) throw new Error("Модель не вернула итоговый ответ");
  res.json({ answer: finalText, model: openaiModel });
}));

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
