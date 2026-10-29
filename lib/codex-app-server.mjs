// The official app-server creates desktop-visible sessions and owns approval review.
// Never edit Codex's SQLite source flags or accept its approval requests from this client.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function usagePolicy(reserve = 20, weeklyReserve = reserve, weeklyFallback = false) {
  for (const [name, value] of [['usage_reserve_percent', reserve], ['weekly_usage_reserve_percent', weeklyReserve]]) {
    if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error(`Codex ${name} must be an integer from 1 to 99`);
  }
  if (typeof weeklyFallback !== 'boolean') throw new Error('Codex weekly_fallback_claude must be a boolean');
  return { primary: reserve, secondary: weeklyReserve, weeklyFallback };
}
export function assertUsageReserve(snapshot, reserve, weeklyReserve = reserve, weeklyFallback = false) {
  const policy = usagePolicy(reserve, weeklyReserve, weeklyFallback);
  const hold = reason => Object.assign(new Error(`Codex quota hold: ${reason}`), { code: 'CYCLER_QUOTA_HOLD' });
  const bucket = snapshot?.rateLimitsByLimitId == null ? snapshot?.rateLimits : snapshot.rateLimitsByLimitId.codex;
  if (!bucket || (bucket.limitId && bucket.limitId !== 'codex')) throw hold('Codex usage snapshot is unavailable');
  for (const [name, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]]) {
    if (!Number.isFinite(window?.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) throw hold(`${name} usage data is unavailable`);
  }
  // A verified weekly ceiling selects another subscription even if Codex itself is exhausted.
  // Missing window data above must never become permission to launch a fallback.
  if (policy.weeklyFallback && bucket.secondary.usedPercent >= 100 - policy.secondary) throw Object.assign(
    new Error(`Codex weekly ceiling reached: ${bucket.secondary.usedPercent}% used; switching to Claude`),
    { code: 'CYCLER_WEEKLY_FALLBACK', resetsAt: bucket.secondary.resetsAt ?? null });
  if (snapshot?.ordinaryUsageAllowed !== true) throw hold('ordinary included usage is denied or unavailable');
  for (const [name, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]]) {
    if (window.usedPercent >= 100 - policy[name]) throw Object.assign(hold(`${name} is ${window.usedPercent}% used; reserving ${policy[name]}%`),
      { window: name, resetsAt: window.resetsAt ?? null });
  }
}

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
  approvals = 'deny', readOnly = false, env = process.env, timeout = 1800000, onThread, threadId, ephemeral = false, usageReservePercent, weeklyUsageReservePercent, weeklyFallbackClaude = false } = {}) {
  if (!['deny', 'auto-review'].includes(approvals)) return Promise.reject(new Error(`Invalid Codex approvals setting: ${approvals}`));
  if (threadId && ephemeral) return Promise.reject(new Error('An ephemeral check cannot resume a workflow thread'));
  if (usageReservePercent != null || weeklyUsageReservePercent != null || weeklyFallbackClaude) {
    try { usagePolicy(usageReservePercent ?? 20, weeklyUsageReservePercent ?? usageReservePercent ?? 20, weeklyFallbackClaude); }
    catch (error) { return Promise.reject(error); }
  }
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
    const startThread = () => {
      const automatic = !readOnly && approvals === 'auto-review';
      send({ id: 2, method: threadId ? 'thread/resume' : 'thread/start', params: {
        cwd, model, ...(threadId ? { threadId } : { ephemeral }),
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        approvalPolicy: automatic ? 'on-request' : 'never',
        approvalsReviewer: automatic ? 'auto_review' : 'user',
      } });
    };
    const startTurn = async () => {
      await onThread?.({ id: thread.id, name, model: actualModel, cwd: thread.cwd || cwd, source: thread.source, ephemeral });
      send({ id: 4, method: 'turn/start', params: {
        threadId: thread.id, input: [{ type: 'text', text: prompt }],
        ...(schema ? { outputSchema: codexOutputSchema(schema) } : {}),
      } });
    };
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
        if (message.error) {
          if (message.id === 5) finish(Object.assign(new Error(`Codex quota hold: usage read failed: ${message.error.message}`), { code: 'CYCLER_QUOTA_HOLD' }));
          else fail(`Codex app-server: ${message.error.message}`);
          return;
        }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          if (usageReservePercent != null || weeklyUsageReservePercent != null || weeklyFallbackClaude) send({ id: 5, method: 'account/rateLimits/read', params: {} });
          else startThread();
        } else if (message.id === 5) {
          assertUsageReserve(message.result, usageReservePercent ?? 20, weeklyUsageReservePercent ?? usageReservePercent ?? 20, weeklyFallbackClaude);
          startThread();
        } else if (message.id === 2) {
          thread = message.result?.thread;
          if (!thread?.id) { fail('Codex app-server returned no thread identity'); return; }
          if (threadId && thread.id !== threadId) { fail('Codex resumed a different thread'); return; }
          actualModel = message.result.model || model;
          // Ephemeral threads have no persistent metadata to rename.
          if (ephemeral) await startTurn();
          else send({ id: 3, method: 'thread/name/set', params: { threadId: thread.id, name } });
        } else if (message.id === 3) {
          await startTurn();
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
