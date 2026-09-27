// A local JSON-lines adapter. This is not an installed Codex or Claude plugin.
import readline from 'node:readline';
const base = new URL(process.env.TC_AGENT_API_URL || 'http://127.0.0.1:3001');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Agent adapter accepts only a local loopback API.');
const allowed = ['get_project_context', 'find_project_evidence', 'trace_dependency_impact', 'propose_project_change', 'run_project_scenario'];
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
    if (!allowed.includes(request.tool) || typeof request.project_id !== 'string') throw new Error('Unknown tool or missing project_id.');
    const prefix = `/api/projects/${encodeURIComponent(request.project_id)}`;
    let route, body;
    if (request.tool === 'get_project_context') route = `${prefix}/agent-context`;
    if (request.tool === 'find_project_evidence') route = `${prefix}/sources/${encodeURIComponent(request.source_id)}/quote?${new URLSearchParams({ quote: request.quote || '', location: request.location || '' })}`;
    if (request.tool === 'trace_dependency_impact') route = `${prefix}/impact?taskId=${encodeURIComponent(request.task_id)}`;
    if (request.tool === 'propose_project_change') { route = `${prefix}/agent-proposals`; body = request.proposal; }
    if (request.tool === 'run_project_scenario') { route = `${prefix}/scenarios`; body = { config: request.config }; }
    const response = await fetch(new URL(route, base), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotency_key || '' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: response.ok, result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ id: request?.id ?? null, ok: false, error: error.message }) + '\n'); }
}
