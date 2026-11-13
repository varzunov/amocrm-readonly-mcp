export function toUnix(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid ISO date: ${value}`);
  return Math.floor(parsed / 1000);
}

export function leadFilters(input: {
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  pipelineId?: number;
  statusId?: number;
  responsibleUserId?: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  const setTime = (field: string, edge: "from" | "to", value?: string) => {
    const timestamp = toUnix(value);
    if (timestamp !== undefined) params.set(`filter[${field}][${edge}]`, String(timestamp));
  };
  setTime("created_at", "from", input.createdFrom);
  setTime("created_at", "to", input.createdTo);
  setTime("updated_at", "from", input.updatedFrom);
  setTime("updated_at", "to", input.updatedTo);
  if (input.pipelineId !== undefined) params.set("filter[statuses][0][pipeline_id]", String(input.pipelineId));
  if (input.statusId !== undefined) params.set("filter[statuses][0][status_id]", String(input.statusId));
  if (input.responsibleUserId !== undefined) params.set("filter[responsible_user_id]", String(input.responsibleUserId));
  return params;
}
