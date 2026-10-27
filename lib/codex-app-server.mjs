// The official app-server creates desktop-visible sessions and owns approval review.
// Never edit Codex's SQLite source flags or accept its approval requests from this client.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Codex strict output requires every declared field; requiring optional fields too
// narrows the accepted output without weakening the workflow's local validator.
export function codexOutputSchema(schema) {
  if (Array.isArray(schema)) return schema.map(codexOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, codexOutputSchema(value)]));
  if (schema.type === 'object') {
    result.required = Object.keys(schema.properties || {});
    result.additionalProperties = false;
  }
  return result;
}

export function runCodexAppServer({ bin, args = [], cwd, model, prompt, schema, name = 'Cycler',
  approvals = 'deny', readOnly = false, env = process.env, timeout = 1800000, onThread } = {}) {
  if (!['deny', 'auto-review'].includes(approvals)) return Promise.reject(new Error(`Invalid Codex approvals setting: ${approvals}`));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let thread, actualModel = model, answer = '', stderr = '', settled = false, killTimer;
    const lines = createInterface({ input: child.stdout });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      // Closing stdio normally shuts down app-server. Bound shutdown on broken servers too.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
      child.kill('SIGTERM');
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Codex app-server timed out after ${timeout}ms`)), timeout);
    const send = message => { if (!settled) child.stdin.write(JSON.stringify(message) + '\n'); };
    const fail = message => finish(new Error(message));
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', error => finish(error));
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (!settled) fail(`Codex app-server exited before completion (${signal || code}): ${stderr.slice(-2000)}`);
    });
    lines.on('line', async line => {
      if (settled) return;
      try {
        const message = JSON.parse(line);
        // Requests here require an interactive client decision. Automatic review must be
        // performed inside Codex; replying "accept" ourselves would bypass that reviewer.
        if (message.id != null && message.method) {
          fail(`Codex app-server requires client action: ${message.method}. No approval was granted; review the session in desktop.`);
          return;
        }
        if (message.error) { fail(`Codex app-server: ${message.error.message}`); return; }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          const automatic = !readOnly && approvals === 'auto-review';
          send({ id: 2, method: 'thread/start', params: {
            cwd, model, ephemeral: false,
            sandbox: readOnly ? 'read-only' : 'workspace-write',
            approvalPolicy: automatic ? 'on-request' : 'never',
            approvalsReviewer: automatic ? 'auto_review' : 'user',
          } });
        } else if (message.id === 2) {
          thread = message.result?.thread;
          if (!thread?.id) { fail('Codex app-server returned no thread identity'); return; }
          actualModel = message.result.model || model;
          send({ id: 3, method: 'thread/name/set', params: { threadId: thread.id, name } });
        } else if (message.id === 3) {
          await onThread?.({ id: thread.id, name, model: actualModel, cwd: thread.cwd || cwd, source: thread.source });
          send({ id: 4, method: 'turn/start', params: {
            threadId: thread.id, input: [{ type: 'text', text: prompt }],
            ...(schema ? { outputSchema: codexOutputSchema(schema) } : {}),
          } });
        } else if (message.method === 'item/completed' && message.params?.threadId === thread?.id) {
          const item = message.params.item;
          // Explicit progress is not a final result, even when it happens to be JSON.
          // Older servers omit phase; retain their completed-message compatibility.
          if (item?.type === 'agentMessage' && (item.phase == null || item.phase === 'final_answer')) answer = item.text || '';
        } else if (message.method === 'turn/completed' && message.params?.threadId === thread?.id) {
          const turn = message.params.turn;
          if (turn?.status !== 'completed') fail(`Codex turn ${turn?.status || 'unknown'}: ${turn?.error?.message || 'no successful result'}`);
          else if (!answer.trim()) fail('Codex completed without a final answer');
          else finish(null, answer);
        }
      } catch (error) { finish(error); }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'cycler', title: 'Cycler', version: '0.2.23' },
      capabilities: { experimentalApi: true },
    } });
  });
}
