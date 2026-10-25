// Provider adapters shared by the workflow runner and independent review harness.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick } from './yaml.mjs';

export const get = (obj, path) => path.split('.').reduce((v, k) => pick(v, k), obj);
export const expand = (s) => String(s).replace(/^~(?=$|\/)/, homedir());
export function runtimeName(config = {}, override) {
  const name = override || process.env.CYCLER_RUNTIME || get(config, 'dispatch.runtime') || 'claude';
  if (!['claude', 'codex', 'dsh'].includes(name)) throw new Error(`Unknown runtime: ${name}`);
  return name;
}
export function stageRoute(config, label, fallback, model) {
  const review = /^(review:|refute:|synthesis)/.test(label);
  const routes = get(config, 'review.lenses') || {};
  const entry = pick(routes, label.replace(/^review:/, ''));
  const runtime = runtimeName(config, get(entry, 'runtime') || (review && get(config, 'review.runtime')) || fallback);
  // Claude aliases must never leak into another provider.
  const selected = get(entry, 'model') || (review && get(config, 'review.model'))
    || (runtime === fallback ? model : null) || get(config, `runtimes.${runtime}.model`);
  return { runtime, model: runtime !== 'claude' && ['opus', 'sonnet', 'haiku'].includes(selected) ? undefined : selected };
}
export function invocation({ runtime, config = {}, prompt, model, output, cwd, readOnly = false }) {
  const settings = get(config, `runtimes.${runtime}`) || {};
  const bin = process.env[`${runtime.toUpperCase()}_BIN`] || get(settings, 'bin') || runtime;
  const extra = get(settings, 'args') || [];
  if (!Array.isArray(extra) || extra.some(x => typeof x !== 'string')) throw new Error(`runtimes.${runtime}.args must be a string list`);
  if (runtime === 'codex') return [expand(bin), 'exec', '--cd', cwd, '--sandbox', readOnly ? 'read-only' : (get(settings, 'sandbox') || 'workspace-write'),
    ...(model ? ['--model', model] : []), ...extra, '--output-last-message', output, '--', prompt];
  if (runtime === 'claude') return [expand(bin), '--print', '--output-format', 'text',
    ...(model ? ['--model', model] : []), ...extra, '--', prompt];
  if (runtime === 'dsh') {
    const patch = model ? pick(get(settings, 'model_patches') || {}, model) : get(settings, 'patch');
    if (model && !patch) throw new Error(`DSH model ${model} requires runtimes.dsh.model_patches.${model} (a Cordis overlay)`);
    return [expand(bin), '--profile', get(settings, 'profile') || 'headless', ...(patch ? ['--patch', expand(patch)] : []), ...extra, '--json', '--', prompt];
  }
  throw new Error(`Unknown runtime: ${runtime}`);
}
export function execute(argv, { cwd, env = process.env, timeout = 1800000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    let killTimer;
    const timer = setTimeout(() => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }, timeout);
    child.stdout.on('data', d => { out += d; if (out.length > 16 * 1024 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', d => { err = (err + d).slice(-16000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (code !== 0) reject(new Error(`${argv[0]} failed (${signal || code}): ${err.slice(-2000)}`));
      else resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function dshAnswer(text) {
  const events = String(text).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const final = events.filter(e => e.type === 'final').at(-1);
  if (!final || typeof final.text !== 'string' || events.some(e => e.type === 'error')) throw new Error('DSH produced no successful final event');
  return final.text;
}
export function dshSession(text) {
  const first = String(text).split('\n').find(line => line.startsWith('{"type":"session"'));
  if (!first) throw new Error('DSH produced no session identity for structured-output retry');
  const id = JSON.parse(first).sessionId;
  if (typeof id !== 'string' || !/^session-[0-9a-f-]{36}$/i.test(id)) throw new Error('DSH produced an invalid session identity');
  return id;
}
export function parseResult(text) {
  const stripped = String(text).trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, '');
  return JSON.parse(stripped);
}
// Validate the schema subset used by the workflow, independently of model claims.
export function validate(value, schema, path = '$') {
  if (!schema) return;
  const type = schema.type;
  const ok = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (type && !ok) throw new Error(`${path}: expected ${type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid enum`);
  if (type === 'object') {
    for (const k of schema.required || []) if (!(k in value)) throw new Error(`${path}.${k}: missing`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.additionalProperties === false && !(k in (schema.properties || {}))) throw new Error(`${path}.${k}: unexpected`);
      if (schema.properties?.[k]) validate(v, schema.properties[k], `${path}.${k}`);
    }
  }
  if (type === 'array') {
    if (schema.maxItems != null && value.length > schema.maxItems) throw new Error(`${path}: too many items`);
    value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`));
  }
}
export async function runAgent({ config = {}, runtime, model, prompt, schema, cwd, readOnly = false, run = execute }) {
  const temp = mkdtempSync(join(tmpdir(), 'cycler-agent-'));
  try {
    const output = join(temp, 'answer.txt');
    const instruction = `${prompt}\n\n${readOnly ? 'Review only. Do not edit files or publish comments; the controller publishes verified results.' : ''}\n`
      + (schema ? `Return ONLY a JSON object matching this JSON Schema, without markdown:\n${JSON.stringify(schema)}` : '');
    const argv = invocation({ runtime, config, model, prompt: instruction, output, cwd, readOnly });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const env = { ...process.env, CYCLER_RUNTIME: runtime, CYCLER_ROOT: root, CLAUDE_PLUGIN_ROOT: root, CYCLER_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd,
      ...(runtime === 'dsh' && readOnly ? { DSH_PERMISSION_MODE: 'read-only' } : {}) };
    delete env.CLAUDECODE;
    const options = { cwd, env, timeout: Number(get(config, 'dispatch.stage_timeout_seconds') || 1800) * 1000 };
    const text = await run(argv, options);
    let result = runtime === 'codex' ? readFileSync(output, 'utf8') : runtime === 'dsh' ? dshAnswer(text) : text;
    if (!schema) return result;
    if (runtime === 'dsh') {
      try { parseResult(result); }
      catch {
        const session = dshSession(text);
        const retry = invocation({ runtime, config, model,
          prompt: `Finish the previous task. Your last answer was not valid JSON. Return ONLY a complete JSON object matching this schema, with no introduction or markdown:\n${JSON.stringify(schema)}`,
          output, cwd, readOnly });
        retry.splice(retry.indexOf('--'), 0, '--session-id', session);
        result = dshAnswer(await run(retry, options));
      }
    }
    const parsed = parseResult(result);
    validate(parsed, schema);
    return parsed;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
