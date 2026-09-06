// lib/yaml.mjs — the cycler config reader, shared by the poller and the harness hooks.
//
// The parser handles the subset the config actually uses: nested maps by indentation, scalar
// values, inline lists (`[a, b]`) and block lists (`- a`, including `- key: value` entries). It is
// not a general YAML implementation and does not pretend to be — a config file that needs more than
// this has outgrown being config.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ONE config file. There used to be two — cycler.yaml in the repo and ~/.cycler/config.json for the
// OAuth credentials — and every question about cycler started with "which file?". Splitting a config
// by secrecy also split it by nothing else: repo.base and client_secret are both things you type once
// and never think about again. They live together now, in a file that is not in a repo and therefore
// never at risk of being committed.
//
// ~/.cycler/ still exists, but holds no config: only state the poller WRITES (the refreshing OAuth
// token, the processed-issue list, the launchd logs). A file a program rewrites every 24h cannot also
// be the file you hand-edit.
export function configHome() {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'cycler')
    : join(homedir(), '.config', 'cycler');
}

export function configPath() {
  // $CYCLER_CONFIG wins, and wins even when it does not exist — a path given explicitly and silently
  // ignored is how you debug the wrong file for an hour.
  if (process.env.CYCLER_CONFIG) return process.env.CYCLER_CONFIG;
  const p = join(configHome(), 'config.yaml');
  return existsSync(p) ? p : null;
}

// Never throws. A malformed or missing config must degrade to defaults, not stop a poll — a poller
// that dies on config is a poller that stops dispatching silently, which is the failure mode this
// whole thing exists to avoid.
export function readConfig() {
  try {
    const p = configPath();
    return p && existsSync(p) ? parseYaml(readFileSync(p, 'utf8')) : {};
  } catch {
    return {};
  }
}

// Keys are canonically snake_case, but `branch_prefix`, `branchPrefix` and `branch-prefix` all
// resolve to the same value. Not politeness: the keys renamed to snake_case in this release, and a
// key spelled the old way would otherwise be read as absent — which for dispatch.path_prepend means
// a session that cannot find `node` and stalls asking a human. Silence is the wrong answer for a
// key the user clearly meant.
const fold = (s) => String(s).toLowerCase().replace(/[-_]/g, '');

export function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  const want = fold(key);
  for (const k of Object.keys(obj)) if (fold(k) === want) return obj[k];
  return undefined;
}

export function get(cfg, dotted) {
  let cur = cfg;
  for (const part of dotted.split('.')) {
    cur = pick(cur, part);
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  let pending = null;      // { parent, key } — the map key a following `- ` line turns into a list
  let listItem = null;     // the map created by a `- key: value` entry, so its siblings attach to it
  let listIndent = -1;
  let block = null;        // { target, key, fold, indent, lines } — an open `|` or `>` block scalar

  const closeBlock = () => {
    if (!block) return;
    const body = block.fold ? block.lines.join(' ').replace(/\s+/g, ' ').trim()
                            : block.lines.join('\n').replace(/\n+$/, '');
    block.target[block.key] = body;
    block = null;
  };

  const lines = text.split('\n');
  for (const raw of lines) {
    const rawIndent = raw.length - raw.trimStart().length;

    // Inside an open block scalar, lines are CONTENT, not structure: no comment stripping, no
    // key parsing. The block ends at the first non-blank line indented no further than its key.
    if (block) {
      if (!raw.trim()) { block.lines.push(''); continue; }
      if (rawIndent > block.indent) { block.lines.push(raw.slice(block.bodyIndent ?? (block.bodyIndent = rawIndent))); continue; }
      closeBlock();
    }

    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = rawIndent;
    const body = line.trim();

    if (body.startsWith('- ')) {
      if (!pending) continue;
      const { parent, key } = pending;
      if (!Array.isArray(parent[key])) parent[key] = [];
      const item = body.slice(2);
      const m = item.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m) {
        // `- label: research` — a list OF MAPS. Deeper lines that follow belong to this entry.
        listItem = { };
        listIndent = indent;
        parent[key].push(listItem);
        if (!assignMaybeBlock(listItem, m[1], m[2], indent)) listItem[m[1]] = scalar(m[2]);
      } else {
        parent[key].push(scalar(item));
        listItem = null;
      }
      continue;
    }

    // A line indented past the `- ` that opened the current list entry is one of its fields.
    if (listItem && indent > listIndent) {
      const m = body.match(/^([^:]+):\s*(.*)$/);
      if (m && !assignMaybeBlock(listItem, m[1], m[2], indent)) listItem[m[1]] = scalar(m[2]);
      continue;
    }
    listItem = null;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;

    if (assignMaybeBlock(parent, key, rest, indent)) continue;

    if (rest === '') {
      // Ambiguous until the next line: a nested map, or a block list. Start as a map and let a
      // following `- ` replace it, so both shapes parse without lookahead.
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
      pending = { parent, key };
    } else {
      parent[key] = scalar(rest);
      pending = null;
    }
  }
  closeBlock();
  return root;

  // `key: >` folds the following indented lines into one line; `key: |` keeps the newlines. The
  // shipped example uses `>` for dispatch.command, and without this the value parsed as the literal
  // ">" — so the poller would have tried to spawn a process called ">".
  function assignMaybeBlock(target, key, rest, indent) {
    const t = rest.trim();
    if (t !== '>' && t !== '|' && t !== '>-' && t !== '|-') return false;
    block = { target, key, fold: t.startsWith('>'), indent, lines: [], bodyIndent: null };
    pending = null;
    return true;
  }
}

export function scalar(v) {
  v = String(v).trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => scalar(s)).filter((s) => s !== '');
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
