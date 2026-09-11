// Exercise the real tool/context path without placing a call or printing source
// content or credentials. Context must refer to an existing authorized call.
import 'dotenv/config';
import { executeTool } from '../tools.js';

const input = JSON.parse(process.argv[2] || '{}');
if (!input.context || !input.projectReference || !input.expectedProjectId) {
    throw new Error('Provide context, projectReference and expectedProjectId as JSON');
}
const count = Math.max(1, Math.min(3, Number(input.count) || 1));
for (let sample = 1; sample <= count; sample++) {
    const result = await executeTool('select_hyperflow_project', {
        project_reference: input.projectReference,
        question: 'What was the latest code I sent by SMS?',
    }, input.context);
    const valid = !result.error && result.output?.routing?.kind === 'routed' &&
        result.output.routing.projectId === input.expectedProjectId &&
        result.output.project?.context?.history?.status === 'current';
    console.log(JSON.stringify({ sample, durationMs: result.durationMs, passed: valid,
        error: result.error || null, projectId: result.output?.routing?.projectId || null,
        history: result.output?.project?.context?.history?.status || null,
        sourceCount: result.output?.project?.context?.history?.sources?.length || 0 }));
    if (!valid) { process.exitCode = 1; break; }
}
