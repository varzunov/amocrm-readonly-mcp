type Pipeline = {
  id: number;
  name: string;
  _embedded?: { statuses?: Array<{ id: number; name: string }> };
};

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
};

export function summarizeLeads(leads: Lead[], pipelines: Pipeline[], staleDays: number, now = Date.now()) {
  const pipelineNames = new Map(pipelines.map(p => [p.id, p.name]));
  const statusNames = new Map<number, string>();
  for (const pipeline of pipelines) {
    for (const status of pipeline._embedded?.statuses || []) statusNames.set(status.id, status.name);
  }
  const stages = new Map<string, { count: number; value: number }>();
  const managers = new Map<number, { count: number; value: number; open: number; won: number; lost: number; stale_open: number }>();
  const staleLeads: Array<{ id: number; name: string; value: number; pipeline_id?: number; status_id?: number; responsible_user_id?: number; updated_at: string | null; stale_days: number }> = [];
  const cutoff = Math.floor(now / 1000) - staleDays * 86400;
  let totalValue = 0;
  let wonCount = 0;
  let lostCount = 0;
  let openCount = 0;
  let staleOpenCount = 0;

  for (const lead of leads) {
    const price = lead.price || 0;
    totalValue += price;
    const key = `${pipelineNames.get(lead.pipeline_id || 0) || lead.pipeline_id || "unknown"} / ${statusNames.get(lead.status_id || 0) || lead.status_id || "unknown"}`;
    const stage = stages.get(key) || { count: 0, value: 0 };
    stage.count += 1;
    stage.value += price;
    stages.set(key, stage);
    const managerId = lead.responsible_user_id || 0;
    const manager = managers.get(managerId) || { count: 0, value: 0, open: 0, won: 0, lost: 0, stale_open: 0 };
    manager.count += 1;
    manager.value += price;
    if (lead.status_id === 142) {
      wonCount += 1;
      manager.won += 1;
    }
    else if (lead.status_id === 143) {
      lostCount += 1;
      manager.lost += 1;
    }
    else {
      openCount += 1;
      manager.open += 1;
      if ((lead.updated_at || 0) < cutoff) {
        staleOpenCount += 1;
        manager.stale_open += 1;
        staleLeads.push({
          id: lead.id,
          name: lead.name,
          value: price,
          pipeline_id: lead.pipeline_id,
          status_id: lead.status_id,
          responsible_user_id: lead.responsible_user_id,
          updated_at: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
          stale_days: Math.max(0, Math.floor((Math.floor(now / 1000) - (lead.updated_at || 0)) / 86400)),
        });
      }
    }
    managers.set(managerId, manager);
  }

  return {
    leads: leads.length,
    total_value: totalValue,
    open: openCount,
    won: wonCount,
    lost: lostCount,
    stale_open: staleOpenCount,
    stages: [...stages.entries()]
      .map(([stage, values]) => ({ stage, ...values }))
      .sort((a, b) => b.count - a.count),
    managers: [...managers.entries()]
      .map(([responsible_user_id, values]) => ({ responsible_user_id, ...values }))
      .sort((a, b) => b.value - a.value),
    stale_leads: staleLeads
      .sort((a, b) => b.value - a.value || b.stale_days - a.stale_days)
      .slice(0, 50),
  };
}
