// Single-workflow task lifecycle: contract -> implement -> audit -> verify -> commit -> PR -> review.
// The pre-commit gate (audit -> verify) loops back to IMPLEMENT with the exact issues until clean. Then
// the diff is committed, the branch pushed, and a PR opened to args.prBase (default main). Review runs
// against the committed diff (git diff <prBase>...HEAD); blocking issues loop back to IMPLEMENT, and each
// fix round is committed and pushed to the SAME PR. The harness NEVER merges.
// Fix rounds are capped by TWO SEPARATE budgets (APL-9): args.gateFixMax for the pre-commit loop
// (audit/verify) and args.reviewFixMax for the post-commit review loop. Both default to args.fixMax
// (default 2). They no longer share one counter, so a task that burns every gate round still opens its PR
// with a full review budget. Invoked via scriptPath, so the file name stays
// task-orchestration.js; the display name is task-orchestration.
// stopAtContract: true makes the run stop right after the contract stage with status 'plan' (plan-mode
// sign-off) — the orchestrator presents the contract as a plan, then re-invokes with contractPath.
// A Branch stage runs before IMPLEMENT: it creates/reuses `claude/<ISSUE_ID>` off an up-to-date prBase, so
// the harness never commits onto the base branch (APL-34). issueId is taken from args.issueId or parsed out
// of the task text (e.g. "APL-10"); with neither, it falls back to the contract slug.
// Models are routed per stage (see DEFAULT_MODELS): contract runs on the strongest model, the mechanical
// stages (branch/commit/pr) on the cheapest, the rest inherit. Override with args.models, e.g.
// { models: { verify: 'haiku', 'review:bugs': 'opus' } }; pass null for a stage to force inherit.
// APL-45: two runs can share a machine but not a working tree. `worktree: true` gives the run its own
// git worktree under .claude/worktrees/<branch-slug> and points every stage at it, so N runs on N
// branches are safe — git's refusal to check one branch out twice IS the per-branch lock. Without it the
// run works in the shared checkout and takes an exclusive lock first; a second shared-tree run is
// REFUSED with the holder named, never silently interleaved. A clean worktree run removes its worktree
// (the branch is pushed, the PR is open); a blocked one keeps it and reports the path, because that
// directory is the evidence. Caveat that does not go away: the token budget is shared across concurrent
// workflows, so pass an explicit budget when running several — each one's guard only sees the shared pool.
// Invoke: Workflow({ scriptPath: '<CLAUDE_PLUGIN_ROOT>/workflows/task-orchestration.js', args: { task?, contractPath?, cwd?, worktree?, executorModel?, models?, noCommit?, stopAtContract?, fixMax?, gateFixMax?, reviewFixMax?, prBase?, issueId?, branch? } })
// Fan-out is capped (APL-8): see MAX_FINDINGS_PER_LENS / MAX_REFUTERS_PER_ROUND / MAX_CHECKS below.
// Review fix rounds are narrowed (APL-42): later rounds re-run only the live lenses, over the fix diff.
// Anything not re-examined is named in the result's reviewCoverage — never silent.
// Worst case per run = 1 contract + 1 branch + gateFixMax+1 x (implement + audit + verify)
//   + (reviewFixMax+1) x (4 lenses + MAX_REFUTERS_PER_ROUND + 1 synthesis)
//   + reviewFixMax x (implement + commit) + 1 commit + 1 PR.
// With the defaults (gateFixMax = reviewFixMax = 2) that ceiling is ~70 agents. APL-42 lowers the TYPICAL
// lens count (4 per round -> 2), not that ceiling. Anything dropped by a cap is log()'d and
// reported in the result — a truncated review must never read as an exhaustive one.
// APL-35: the task may be given as a Linear issue URL or bare key instead of a description. The key is
// parsed out either way and drives the branch name, the contract filename (<apl-9>-<slug>.md), the commit
// subject and the PR body; when the request is ONLY a reference, the contract author resolves the issue
// through the Linear MCP and contracts from its title + description.
// APL-36: Linear round-trip. When the run has a Linear issue key (args.issueId, or one parsed out of the
// task text), a cheap LINEAR SYNC agent writes back at each meaningful transition: In Progress on branch,
// PR attached + In Review on PR open, a gate-summary comment on approval, and — the path that matters most
// — a comment naming the stage, lastFailure and fixLog on every blocked return, with the issue moved back
// to Todo. An unattended run that fails silently is worse than one that never started; the Linear comment
// is the only channel that reaches a human who is not watching the chat.
// Every write is idempotent (marker-comment guarded) and NON-FATAL: a Linear failure is recorded in the
// result's `linear` log, never a reason to fail the task. Disable with args.linear: false.
// APL-37: unattended runs. `unattended: true` is the "one line, then walk away" mode — it refuses to
// stop for a human (stopAtContract is forced off; a question goes to the tracker and the run exits),
// applies the budget floor to EVERY loop rather than only Review, and guarantees an honest terminal
// state: the result always carries `terminal`, which is exactly one of 'pr-opened' / 'no-pr'. See the
// "Unattended runs" section of HARNESS.md for the permission requirement, which is not enforceable from
// inside this script.
// Plain JS only (this runtime is not TypeScript). args is a global.

export const meta = {
  name: 'task-orchestration',
  description: 'Full task in one run: contract -> implement -> audit -> verify -> commit -> PR -> review (fixes pushed to the PR until clean)',
  phases: [
    { title: 'Contract', detail: 'author the task contract from the request' },
    { title: 'Branch', detail: 'create/reuse claude/<ISSUE_ID> off an up-to-date base branch' },
    { title: 'Implement', detail: 'implementer makes the minimal diff (re-entered on each fix round)' },
    { title: 'Audit', detail: 'contract-compliance short-circuit' },
    { title: 'Verify', detail: 'single gate agent: plans, runs checks in parallel, reports' },
    { title: 'Commit', detail: 'commit + push the gated diff' },
    { title: 'PR', detail: 'open a pull request to the base branch (never merge)' },
    { title: 'Review', detail: '4 lenses, adversarial refute, synthesis (post-commit)' },
    { title: 'Follow-ups', detail: 'triage the contract follow-ups and file the survivors in Linear' },
    { title: 'Cleanup', detail: 'release the shared-tree lock; remove the worktree on a clean finish' },
  ],
}

// APL-45: two different directories, and conflating them is what made parallel runs impossible.
// `repoRoot` is the checkout the harness was invoked against — it owns the worktree registry and the
// shared-tree lock, and the Branch stage operates on it. `runCwd` is where THIS RUN's stages actually
// work: the same directory in shared-tree mode, a dedicated worktree in `worktree: true` mode. Every
// repo-reading stage must interpolate `runCwd`, never `repoRoot`, or it reads a tree that is not the
// one being changed. It is reassigned exactly once, by the Branch stage; the stage prompts are template
// literals inside functions, so they pick up the final value at call time.
// cycler: no hardcoded checkout. args.cwd is what the /task skill passes from cycler.yaml
// (repo.path); process.cwd() is the fallback for a direct Workflow() call from inside the repo.
const repoRoot = args?.cwd || process.cwd()
// Where the plugin's own scripts and docs live. Every prompt below interpolates this rather than a
// literal path, so the harness works wherever the plugin is installed.
const PLUGIN_ROOT = args?.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT || '.'
let runCwd = repoRoot
// APL-45: opt-in isolation. Default stays shared-tree because it is what every existing caller expects,
// and because a worktree costs a checkout; parallel callers pass worktree: true. Shared-tree runs are
// made safe by the lock below rather than by being trusted not to overlap.
const useWorktree = args?.worktree === true
// Declared up here, not next to the Branch stage, because blocked() closes over them and blocked() can
// fire from the Contract stage — before the Branch stage has run. A `const` declared later would be in
// its temporal dead zone at that point and throw, turning a reportable block into a crash.
const sharedLockPath = `${repoRoot}/.claude/worktrees/.task-shared-tree.lock`
let lockHeld = false        // set true only once the Branch stage confirms it took the lock
let activeWorktree = null   // set to the worktree path once the Branch stage confirms it exists
const taskText = args?.task
const contractPath = args?.contractPath
const model = args?.executorModel // lower model chosen by the orchestrator; omit -> inherit
const noCommit = args?.noCommit === true
const unattended = args?.unattended === true
// APL-37 req 1: an unattended run must never stop to ask. stopAtContract is a request for human sign-off,
// so the two are contradictory — unattended wins, loudly.
const stopAtContract = args?.stopAtContract === true && !unattended
const fixMax = args?.fixMax || 2
// APL-9: the pre-commit gate loop and the post-commit review loop get INDEPENDENT budgets. They used to
// share one counter against fixMax, so a task that needed both gate rounds opened its PR and then hit
// `fixLog.length >= fixMax` on the review loop's first iteration — a published, never-fixable PR plus a
// `blocked` result. Each loop now counts only its own rounds.
const gateFixMax = args?.gateFixMax ?? fixMax
const reviewFixMax = args?.reviewFixMax ?? fixMax
const prBase = args?.prBase || 'main'                       // cycler.yaml: repo.base
const branchPrefix = args?.branchPrefix || 'claude/'        // cycler.yaml: repo.branchPrefix
// APL-36: Linear write-back. Off automatically when the run has no Linear issue key; force off with
// args.linear: false (useful for dry runs and for the harness's own self-edits).
const linearOff = args?.linear === false
// APL-36: a contract with open questions means the harness does not actually know what it was asked to
// build. Default is to stop and ask on the issue rather than implement a guess unattended. Set
// args.stopOnOpenQuestions: false to implement anyway (the questions are still posted).
const stopOnOpenQuestions = args?.stopOnOpenQuestions !== false
// APL-34: the branch the task's work lands on. Explicit args.issueId wins; otherwise parse a Linear-style
// key (APL-10, ENG-7, ...) out of the request text. The convention is <branchPrefix><ISSUE_ID> — note this
// deliberately differs from Linear's own suggested gitBranchName (feature/apl-10); see PIPELINE.md.
// Per-stage model routing. A stage's cost and its need for judgement are not correlated: the contract is
// one agent but every later stage reads it, so a bad one poisons the run; the committer runs `git add` and
// `gh pr create` against success criteria this script re-checks itself.
// Resolution order: args.models[stage] -> DEFAULT_MODELS[stage] -> args.executorModel -> inherit.
// Stage keys: contract, branch, implement, audit, verify, review:<lens>, refute, synthesis, commit, pr.
const DEFAULT_MODELS = {
  contract: 'opus',           // highest leverage in the run — every stage reads it, and its Non-goals are
                              // what let the auditor catch scope creep. One agent, so the upgrade is cheap.
  branch: 'haiku',            // fixed git sequence, and the script re-verifies HEAD landed on the branch
  commit: 'haiku',            // git add/commit/push; the script re-checks pushed === true
  pr: 'haiku',                // one gh call; the script re-checks prUrl
  'review:test-gaps': 'haiku',
  followups: 'haiku',      // reads one section + runs one script; the script re-checks what was filed
  cleanup: 'haiku',          // two rm/worktree commands; the script re-checks the booleans it returns
  // Everything else inherits. Deliberately NOT downgraded:
  //   verify   — it PLANS the gate before running it (which checks apply, how to consolidate, whether the
  //              danger staging set matches git). A weak planner yields a gate that checks the wrong thing,
  //              which passes bad diffs. It is also only 1 agent since the single-agent collapse, so
  //              downgrading it buys little.
  //   audit    — the stage that catches leaked secrets and scope creep.
  //   refute   — defaults to isReal:false when unsure, so a lazy refuter silently drops real findings.
}

function modelFor(stage) {
  const overrides = args?.models || {}
  const picked = stage in overrides ? overrides[stage] : DEFAULT_MODELS[stage]
  return picked ?? model
}

// APL-8: hard caps on fan-out. Every stage that spawns one agent per item is bounded here, so the
// worst-case agent count for a run is arithmetic rather than whatever a model decides to emit.
//   contract 1 + branch 1 + per round (implement 1 + audit 1 + verify 1) + per review round
//   (REVIEW_LENSES + MAX_REFUTERS_PER_ROUND + synthesis 1) + commit/PR 2
// With the defaults below and fixMax 2 that is a ceiling of ~60 agents per run.
const MAX_FINDINGS_PER_LENS = 10   // schema-enforced, so the model cannot exceed it
const MAX_REFUTERS_PER_ROUND = 12  // refuters are 1 agent per finding — the old ~1M burn
const MAX_CHECKS = 10              // matches the "never exceed 10" instruction in the gate prompt
// Stop opening new fan-out when the turn's budget is nearly spent. budget.total is null when the user
// set no target, in which case remaining() is Infinity and these guards never trigger.
const BUDGET_FLOOR = 60_000

// APL-37 req 3: an unattended run with no ceiling is the ~1M-token burn minus the person watching it
// happen. The pre-commit loop was never budget-guarded — only Review was (APL-8) — so a task that kept
// failing its gate could spend the whole turn before Review was ever reached. Guarded in both loops now.
function budgetExhausted() {
  return budget.total != null && budget.remaining() < BUDGET_FLOOR
}

// APL-37 req 4: the terminal state must be unambiguous. Exactly one of these is true at the end of a run,
// and it is stated in the result rather than inferred by the caller from the presence of a `pr` object.
function terminalState(prResult) {
  return prResult && prResult.prUrl ? 'pr-opened' : 'no-pr'
}

// APL-35: the issue key can arrive three ways — args.issueId, a bare key in the request ("APL-10"), or a
// Linear issue URL (.../issue/APL-10/some-slug). The URL is checked first so a link never falls through to
// some unrelated uppercase token elsewhere in the request text.
const LINEAR_URL_RE = /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]*-\d+)/i
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]*-\d+)\b/
// A lowercase key is only accepted when the ENTIRE request is that key ("/task apl-7"). Matching lowercase
// anywhere in free-form text would swallow things like "covid-19" or "utf-8" as issue keys.
const BARE_KEY_RE = /^\s*([A-Za-z][A-Za-z0-9]*-\d+)\s*$/
const issueId = (
  args?.issueId
  || (typeof taskText === 'string' ? (taskText.match(LINEAR_URL_RE) || [])[1] : '')
  || (typeof taskText === 'string' ? (taskText.match(ISSUE_KEY_RE) || [])[1] : '')
  || (typeof taskText === 'string' ? (taskText.match(BARE_KEY_RE) || [])[1] : '')
  || ''
).trim().toUpperCase()
// True when the request is ONLY a Linear reference (a URL or a bare key) — there is no task description
// to contract from, so the contract author must resolve the issue itself before it can write anything.
const taskIsLinearRefOnly = typeof taskText === 'string'
  && issueId !== ''
  && /^\s*(?:https?:\/\/linear\.app\/\S+|[A-Za-z][A-Za-z0-9]*-\d+)\s*$/.test(taskText)

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractPath: { type: 'string' },
    slug: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['contractPath'],
}
const IMPLEMENTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    initialGitStatus: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    commandJournal: { type: 'array', items: { type: 'string' } },
    blockedReason: { type: 'string' },
  },
  required: ['status', 'initialGitStatus', 'changedFiles', 'summary', 'commandJournal'],
}
const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    clean: { type: 'boolean' },
    unauthorizedPaths: { type: 'array', items: { type: 'string' } },
    scopeCreep: { type: 'array', items: { type: 'string' } },
    secrets: { type: 'array', items: { type: 'string' } },
    contractViolations: { type: 'array', items: { type: 'string' } },
  },
  required: ['clean', 'unauthorizedPaths', 'scopeCreep', 'secrets', 'contractViolations'],
}
// Single-agent Verify: the gate plans, runs and reports in one pass and returns a row per check.
// allGreen is NOT taken from the agent — the script derives it from these per-check booleans.
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      maxItems: MAX_CHECKS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          passed: { type: 'boolean' },
          outputTail: { type: 'string' },
        },
        required: ['name', 'command', 'passed'],
      },
    },
    report: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['checks', 'report', 'blockers'],
}
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      maxItems: MAX_FINDINGS_PER_LENS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['blocking', 'non-blocking'] },
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['file', 'severity', 'title', 'description'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { isReal: { type: 'boolean' }, reasoning: { type: 'string' } },
  required: ['isReal', 'reasoning'],
}
const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    blockingIssues: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['approved', 'blockingIssues', 'notes'],
}
const COMMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commitHash: { type: 'string' },
    committedFiles: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
    pushed: { type: 'boolean' },
  },
  required: ['commitHash', 'committedFiles', 'pushed'],
}
const BRANCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branch: { type: 'string' },
    previousBranch: { type: 'string' },
    created: { type: 'boolean' },
    baseSha: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
    // APL-45: shared-tree mode only. True when THIS run created the lock directory, which is what makes
    // it this run's job to remove it. Absent in worktree mode, where git's own "branch already checked
    // out" refusal is the lock and there is nothing to release.
    lockTaken: { type: 'boolean' },
  },
  required: ['branch', 'ok'],
}
// APL-45: booleans, not prose. The caller needs to know whether the lock is actually gone, and a summary
// string cannot be checked — "cleaned up" reads identically whether or not the rm succeeded.
const CLEANUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lockReleased: { type: 'boolean' },
    worktreeRemoved: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['note'],
}
const PR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prUrl: { type: 'string' },
    prNumber: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['prUrl'],
}

const FOLLOWUPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kept: { type: 'array', maxItems: 3, items: { type: 'string' } },
    dropped: { type: 'array', maxItems: 20, items: { type: 'string' } },
    filed: { type: 'array', maxItems: 3, items: { type: 'string' } },
    failed: { type: 'array', maxItems: 3, items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['kept', 'dropped', 'filed', 'failed'],
}

// ---------- Linear round-trip (APL-36) — planned here, PERFORMED by the caller ----------
// This used to spawn a cheap agent per write: 3-4 agents per run at ~39k tokens each, for zero code
// value. It never worked from inside a workflow either — this session exposes more than one Linear
// MCP and a subagent resolved to the unauthenticated one, so in the first real batch EVERY write
// failed (APL-46). APL-46 pinned the server via a probe agent; APL-47 added a breaker to stop paying
// for a dead channel. Both were treating the symptom.
//
// The cause is that a subagent is the wrong actor. The ORCHESTRATOR already holds a working Linear
// connector — it is what files these issues. So the workflow now PLANS the writes and returns them in
// `result.linearWrites`; the caller performs them. Zero subagent tokens, and the auth problem stops
// existing rather than being probed around.
//
// This deletes the APL-46 probe and the APL-47 breaker along with it: there is nothing left to spend,
// so there is nothing to break the circuit on.
//
// The contract the CALLER must honour (see HARNESS.md -> Linear round-trip):
//   1. NEVER fail the task over Linear. A board outage must not turn a green run red.
//   2. NEVER duplicate. Each write carries an HTML-comment marker; check for it (list_comments)
//      before posting, so a resumed or re-run workflow does not spam the issue.
//   3. NEVER hardcode workflow state names — resolve them with list_issue_statuses and match by TYPE.
//   4. Never move the issue to Done. The harness does not merge, so only the human who merges can
//      honestly close it.
const linearKey = /^[A-Z][A-Z0-9]*-\d+$/.test(issueId) ? issueId : ''
const linearEnabled = !linearOff && linearKey !== ''
// The ordered plan. Every entry is a write the caller should perform, or a recorded reason it was not
// planned — an empty array and a disabled round-trip must not look the same.
const linearWrites = []

// kind      — stable slug; becomes the idempotency marker for this write
// stateType — 'started' | 'unstarted' | 'completed', to be resolved to a real workflow state BY TYPE
// body      — markdown comment body (omit for a state/link-only write)
// links     — [{ url, title }] attachments
function linearSync(kind, { stateType, statePreference, body, links, assignSelf } = {}) {
  if (!linearEnabled) {
    linearWrites.push({ kind, skipped: true, note: linearOff ? 'args.linear: false' : 'no Linear issue key for this run' })
    return null
  }
  const marker = `<!-- harness:${linearKey}:${kind} -->`
  linearWrites.push({
    kind,
    issue: linearKey,
    marker,
    stateType: stateType || null,
    statePreference: statePreference || null,
    assignSelf: assignSelf === true,
    links: links || [],
    // The marker leads the body so the caller can match on it verbatim.
    body: body ? `${marker}\n${body}` : null,
  })
  log(`Linear write planned: ${kind}${stateType ? ` (state -> ${stateType})` : ''}${body ? ' + comment' : ''} — `
      + `the CALLER must perform it; the workflow no longer spends an agent on this.`)
  return null
}


function fixLogDigest(fl) {
  if (!fl || !fl.length) return '_No fix rounds were attempted._'
  return fl.map((e, i) => `${i + 1}. **${e.stage}** — ${(e.issues || []).slice(0, 5).map((x) => String(x).split('\n')[0]).join('; ') || 'no issues recorded'}`).join('\n')
}

// APL-45: give back whatever this run is holding, so the next one is not blocked by a corpse.
//
// The asymmetry is deliberate. The LOCK is always released: it holds no work, and a stuck lock stops
// every future shared-tree run. The WORKTREE is removed only on a clean finish, where the branch is
// pushed and the PR is open so the directory holds nothing that is not also on the remote. On a blocked
// run it is kept and its path reported — that directory is the evidence, and deleting it would destroy
// the only copy of a half-finished attempt to save some disk.
//
// Returns a note for the caller. Never throws: cleanup failing must not mask the real outcome.
async function releaseIsolation(outcome) {
  const removeWorktree = useWorktree && activeWorktree && outcome === 'done'
  if (!lockHeld && !removeWorktree) {
    return useWorktree && activeWorktree
      ? `worktree KEPT at ${activeWorktree} (run ended ${outcome}) — inspect it, then remove with: `
        + `git -C ${repoRoot} worktree remove --force ${activeWorktree}`
      : ''
  }
  const steps = []
  if (lockHeld) steps.push(`1. rm -rf "${sharedLockPath}"   (release the shared-tree lock)`)
  if (removeWorktree) {
    steps.push(`${steps.length + 1}. git -C ${repoRoot} worktree remove --force "${activeWorktree}"`
      + `\n   then: git -C ${repoRoot} worktree prune`
      + `\n   The branch is pushed and its PR is open, so removing the directory loses nothing. If the`
      + `\n   remove fails, say so — do NOT rm -rf the directory by hand, that leaves a stale registration.`)
  }
  const res = await agent(
    `You are the CLEANUP step in a strict harness. Make NO code changes and touch NO git branches.
Run exactly these commands, in order, from ${repoRoot}:

${steps.join('\n')}

Report what actually happened. If a command fails, report the failure verbatim — do not retry in a loop
and do not work around it.`,
    { schema: CLEANUP_SCHEMA, label: 'cleanup', phase: 'Cleanup', model: modelFor('cleanup') }
  )
  // APL-7 discipline: a null result means cleanup never ran. Say so rather than reporting it as released.
  if (!res) {
    const note = `APL-45: cleanup agent returned no result — ${lockHeld ? `the lock at ${sharedLockPath} may STILL BE HELD` : ''}`
      + `${lockHeld && removeWorktree ? ' and ' : ''}${removeWorktree ? `the worktree at ${activeWorktree} may still exist` : ''}`
      + `. Remove by hand before the next run.`
    log(note)
    return note
  }
  if (lockHeld) lockHeld = !(res.lockReleased === true)
  if (lockHeld) log(`APL-45: the shared-tree lock at ${sharedLockPath} was NOT released — remove it by hand or the next shared-tree run will refuse to start.`)
  if (removeWorktree && res.worktreeRemoved !== true) {
    log(`APL-45: worktree ${activeWorktree} was not removed: ${res.note || 'no reason given'}`)
  } else if (removeWorktree) {
    activeWorktree = null
  }
  return res.note || ''
}

// Every blocked exit funnels through here, so there is exactly ONE place that can forget to tell Linear.
async function blocked(payload) {
  const stage = payload.stage || 'unknown'
  // APL-37: a budget stop and a rounds-exhausted stop are different failures with different remedies.
  // Without this branch a budget stop reached Linear as "no reason recorded", which is the silent-failure
  // mode both issues exist to prevent.
  const reason = payload.blockedReason
    || (payload.budgetStopped
      ? `the turn's token budget fell below the floor before the ${stage} stage came back clean — the run `
        + 'stopped on COST, not on fix rounds. Re-run with a larger budget; the fix rounds were not used up.'
      : payload.roundsExhausted
        ? `fix rounds exhausted (${payload.fixMax}) — the ${stage} stage never came back clean`
        : 'no reason recorded')
  const lines = [
    `### Harness run blocked at **${stage}**`,
    '',
    `**Reason:** ${reason}`,
  ]
  if (payload.fatal) lines.push('', '**Fatal:** the stage never ran (agent/API failure). No amount of fix rounds would have helped — this needs a human.')
  if (payload.roundsExhausted) lines.push('', `**Rounds exhausted:** ${payload.fixMax}`
    + (payload.gateFixMax != null ? ` (gate budget ${payload.gateFixMax}, review budget ${payload.reviewFixMax})` : ''))
  if (payload.lastFailure) {
    const li = (payload.lastFailure.issues || []).slice(0, 10)
    lines.push('', `**Last failure (${payload.lastFailure.stage}):**`, ...(li.length ? li.map((i) => `- ${i}`) : ['- _none recorded_']))
  }
  lines.push('', '**Fix rounds:**', fixLogDigest(payload.fixLog))
  const narrowed = (payload.reviewCoverage || []).filter((c) => (c.lensesSkipped || []).length > 0)
  if (narrowed.length > 0) {
    lines.push('', '**Review coverage** — later rounds were deliberately narrower than the first (APL-42):',
      ...narrowed.map((c) => `- round ${c.round}: ran ${c.lensesRun.join(', ')}; did NOT re-run ${c.lensesSkipped.join(', ')} (${c.diffScope})`))
  }
  if (payload.pr?.prUrl) lines.push('', `**PR (open, NOT merged):** ${payload.pr.prUrl}`)
  else if (payload.terminal === 'no-pr') lines.push('', '**No PR was opened.** Nothing from this run is on the base branch.')
  if (payload.branch) lines.push('', `**Branch:** \`${payload.branch}\``)
  // APL-45: release before reporting, so the note about what was (or was not) cleaned up reaches the
  // Linear comment too — a leaked lock that only appears in the tool result is a leaked lock nobody sees.
  const cleanupNote = await releaseIsolation('blocked')
  if (cleanupNote) lines.push('', `**Workspace:** ${cleanupNote}`)
  lines.push('', '_Posted by the task harness. Nothing was merged._')

  linearSync(`blocked-${stage}`, {
    // Back to Todo, not Backlog: the run started, so the issue is triaged and actionable — it just needs
    // a human. statePreference keeps a team that renamed its unstarted state working.
    stateType: 'unstarted',
    statePreference: 'Todo',
    body: lines.join('\n'),
  })
  return {
    ...payload,
    // The Linear writes the CALLER must perform — this run did not perform them itself.
    linearWrites,
    worktree: activeWorktree,
    lockHeld,
    cleanupNote,
  }
}

// APL-37 req 1 + 4: in unattended mode the tracker comment is the ONLY channel that reaches a human, so
// a run with nowhere to report is a run that can fail silently. That is the exact failure this mode
// exists to prevent, so say it up front — the run continues, but the caller has been told.
if (unattended) {
  if (!issueId) {
    log('APL-37: unattended run with no tracker issue key — a failure will have NOWHERE to be reported. '
        + 'Pass args.issueId (or a Linear URL/key as the task) so a blocked run can say why.')
  }
  if (args?.stopAtContract === true) {
    log('APL-37: stopAtContract was requested but unattended:true overrides it — an unattended run must '
        + 'never stop for sign-off. The contract will be implemented without review.')
  }
}

// ---------- Stage 1: Contract ----------
let contract = contractPath
let openQuestions = []
if (!contract) {
  phase('Contract')
  const c = await agent(
    `You are the CONTRACT AUTHOR in a strict harness. Repo working dir: ${runCwd}. User's task request: ${JSON.stringify(taskText)}

${taskIsLinearRefOnly ? `0. RESOLVE THE ISSUE FIRST (APL-35). The request above is only a reference to Linear issue
   ${issueId} — it contains no task description, so you cannot contract from it as written. Load the Linear
   MCP tools with ToolSearch { query: "select:get_issue", max_results: 5 } (the real tool name is prefixed —
   match it from the deferred-tool list), then call get_issue { id: "${issueId}" }.
   The issue's TITLE + FULL DESCRIPTION is the task text. Its Goal / Evidence / Acceptance sections map
   almost directly onto the contract template — use them; do not paraphrase the acceptance criteria into
   something vaguer. Note its labels/priority/project as context.
   If get_issue is unavailable or the issue cannot be read, do NOT invent a task: return the contract you
   can write plus an openQuestion saying the issue could not be resolved.
` : `0. If the request references a Linear issue, you may resolve it for context with the Linear MCP
   get_issue tool (load it via ToolSearch first) — but the request text above remains the spec.
`}
1. Read ${PLUGIN_ROOT}/harness/HARNESS.md and ${PLUGIN_ROOT}/harness/CONTRACT.md (the template).
2. Run: git status --short  (do NOT touch existing uncommitted changes).
3. Write the contract to .claude/harness/contracts/${issueId ? `${issueId.toLowerCase()}-` : ''}<short-kebab-slug>.md following the template EXACTLY:
   Goal / Non-goals / Allowed paths / Forbidden paths (use the HARNESS.md repo defaults) /
   Files expected to change / Acceptance checks (each an EXACT runnable command) / Risks & assumptions.
4. ANSWER YOUR OWN QUESTIONS FIRST (APL-47). openQuestions stops the whole run and waits for a human, so
   every question you raise that you could have answered yourself costs a round-trip and roughly 200k
   tokens. Before writing anything into openQuestions, ask: is this OBSERVABLE, or is it a PREFERENCE?

   OBSERVABLE — resolve it yourself, right now, and write the answer into the contract:
     - "which file / how is this currently structured / does X already exist" -> read the code.
     - "what copy or wording" -> grep the surrounding feature for its existing strings and match their
       conventions. An app that says "No applies yet" tells you its own voice.
     - "how should this look / is there room in that header / what does the current screen do" -> for a
       macOS UI question, BUILD AND RUN THE APP AND LOOK AT IT. You have computer-use tools and can take
       a screenshot. A question about what the UI currently does is a fact you can go and check, not a
       decision for the user.
     - "which of two placements is better" -> if one of them is ruled out by what you observe (no room,
       inconsistent with the rest of the app, invisible in the empty state that matters), it is not an
       open question any more. Decide, and record WHY in Risks & assumptions.

   PREFERENCE — genuinely the user's call; these are the only ones worth blocking on:
     - a product stance ("should this empty state read neutrally, or accuse the pipeline of being down")
     - a trade-off only the user can price (scope, risk appetite, what to sacrifice)
     - anything where being wrong is expensive AND the codebase does not imply an answer

   Write your best-effort contract either way. List ONLY unresolved PREFERENCE questions in
   openQuestions. If you resolved something by looking, say so in Risks & assumptions ("chose the header
   subtitle: the axis labels are hidden in both empty states, checked by running the app") so a reviewer
   can challenge the observation rather than re-litigate the question.

Return contractPath and openQuestions. Do NOT make any code changes.`,
    { schema: CONTRACT_SCHEMA, label: 'contract', phase: 'Contract', model: modelFor('contract') }
  )
  contract = c?.contractPath
  openQuestions = c?.openQuestions || []
  if (!contract) {
    return await blocked({ status: 'blocked', stage: 'contract', blockedReason: 'contract author produced no contractPath' })
  }
}

// Plan-mode sign-off: stop here so the orchestrator presents the contract as a plan (ExitPlanMode),
// then re-invokes with contractPath to run implement -> audit -> verify -> review -> commit.
if (stopAtContract) {
  return {
    status: 'plan',
    stage: 'contract',
    contractPath: contract,
    openQuestions,
    // Always present, even though this path plans no writes: SKILL.md tells the caller
    // unconditionally to walk this array, so it must never be undefined.
    linearWrites,
    note: 'stopAtContract — contract authored; present it as a plan, then re-invoke with contractPath',
  }
}

// ---------- Stage 1b: Branch (APL-34) ----------
// Without this the COMMITTER's `git push -u origin HEAD` pushes onto whatever is checked out — which is
// `main` today — and `gh pr create --base main` from main opens a PR from a branch to itself.
// Derive the branch name: <branchPrefix><ISSUE_ID>, else <branchPrefix><contract-slug>.
const contractSlug = String(contract).split('/').pop().replace(/\.md$/, '')
const taskBranch = args?.branch || `${branchPrefix}${issueId || contractSlug}`

// Guard: the task branch must never BE the base branch, or the PR would target itself.
if (taskBranch === prBase) {
  return await blocked({
    status: 'blocked', stage: 'branch', fatal: true,
    blockedReason: `refusing to run: the computed task branch "${taskBranch}" equals prBase "${prBase}". The harness must never commit onto its own PR base. Pass a distinct args.issueId/args.branch, or a different prBase.`,
    contractPath: contract,
  })
}

// APL-45: where this run's worktree lives, and where the shared-tree lock lives. Both sit under
// .claude/worktrees/, which is already gitignored (APL-10), so neither can leak into a diff.
const branchSlug = taskBranch.replace(/[^A-Za-z0-9._-]/g, '-')
const worktreePath = `${repoRoot}/.claude/worktrees/${branchSlug}`
// A lock nobody can break is a lock that ends the session the first time a run crashes. Six hours is
// well past the longest observed run (~40 min) while still clearing a dead lock the same working day.
const LOCK_STALE_HOURS = 6

if (useWorktree) {
  log(`APL-45: isolated run — this task works in ${worktreePath}, not the shared checkout. `
      + `Concurrent runs on other branches are safe; git itself refuses a second worktree on "${taskBranch}".`)
} else {
  log(`APL-45: shared-tree run in ${repoRoot}. Taking the exclusive lock — a second concurrent run will `
      + `be refused, not silently interleaved. Pass worktree: true to run in parallel instead.`)
}

phase('Branch')
const branchRes = await agent(
  useWorktree
    ? `BRANCH MANAGER. Run these commands. Do not explore the repo, read files, or make code changes.
Never 'git switch' in ${repoRoot} — another run may be using it.

  P=${repoRoot}; W="${worktreePath}"; B=${taskBranch}
  git -C $P rev-parse --abbrev-ref HEAD          # -> previousBranch; leave it alone
  git -C $P fetch origin ${prBase} || true       # offline is not a blocker; note it in 'error'

Then ONE of these, in order (idempotent — a re-run reuses an existing worktree):
  a) "$W" exists and 'git -C "$W" rev-parse --abbrev-ref HEAD' == $B  -> reuse as-is, created:false.
     Do NOT reset/rebase/clean it: it may hold this task's earlier rounds.
  b) "$W" exists but is not a worktree on $B  -> ok:false, say what you found. Do NOT delete it.
  c) branch local  (git -C $P show-ref --verify --quiet refs/heads/$B):
       git -C $P worktree add "$W" $B                                          -> created:false
  d) branch remote (git -C $P ls-remote --exit-code --heads origin $B):
       git -C $P worktree add --track -b $B "$W" origin/$B                     -> created:false
  e) else: git -C $P worktree add -b $B "$W" origin/${prBase}                  -> created:true
     (local ${prBase} if origin/${prBase} is missing)

If 'worktree add' fails saying the branch is ALREADY CHECKED OUT elsewhere, another run holds it:
ok:false, say so. Do NOT use --force — that puts two runs on one branch, the exact corruption this
mode exists to prevent.

Then make the gate runnable — 'node_modules' is untracked, so a fresh worktree has none and every
eslint/vitest check would fail on a missing module rather than on the code:
  bash "${PLUGIN_ROOT}/harness/link-workspace.sh" "$W" "$P"
Run it EXACTLY as written. Do NOT substitute 'ln -s "$P/node_modules" "$W/node_modules"'.
That symlink is the bug APL-48, APL-50 and APL-53 EACH lost a fix round to, and AGENTS.md forbids it by
name ("Worktree hazard: never symlink root node_modules"): this repo is an npm workspace, so
$P/node_modules/@applygent/* are symlinks into $P/packages/*. Sharing that directory makes the worktree
compile its own src/ against the MAIN checkout's copy of every workspace package, so exports added in
the worktree appear not to exist —
  Module '"@applygent/shared"' has no exported member 'memoryPath'
— which reads as a code bug, is not one, and cannot be fixed from inside the contract's Allowed paths.
The script gives the worktree a real node_modules: third-party packages symlinked from $P, workspace
packages pointed at $W/packages/*. It is idempotent and self-healing, so re-running it is safe.
If it exits non-zero, report ok:false with its stderr in 'error'. Do NOT continue with a partial
node_modules: that is precisely the shadowed state above, and Verify would hit it as a mystery red.

VERIFY before reporting success:
  git -C "$W" rev-parse --abbrev-ref HEAD   MUST be exactly $B, and MUST NOT be ${prBase}
  git -C $P  rev-parse --abbrev-ref HEAD    MUST be unchanged from the first command
  baseSha = git -C "$W" rev-parse --short HEAD
Any mismatch -> ok:false with what it actually printed. ok:true only if "$W" is verifiably on $B.`
    : `You are the BRANCH MANAGER in a strict harness. Repo working dir: ${runCwd}.
Your ONLY job is to put the repo on the task branch "${taskBranch}", branched off an up-to-date
"${prBase}", and to take the shared-tree lock. Make NO code changes of any kind.

0. APL-45 — TAKE THE LOCK FIRST. This run has the shared checkout to itself or it does not run at all.
   'mkdir' is the atomic test-and-set here; do NOT substitute '[ -e ] && mkdir', which races.
     mkdir -p "${repoRoot}/.claude/worktrees"
     if mkdir "${sharedLockPath}" 2>/dev/null; then
       printf '%s\\n' "${taskBranch}" > "${sharedLockPath}/branch"
       date -u +%Y-%m-%dT%H:%M:%SZ > "${sharedLockPath}/started"
       echo TOOK_LOCK
     else
       echo LOCK_HELD; cat "${sharedLockPath}/branch" "${sharedLockPath}/started" 2>/dev/null
     fi
   - TOOK_LOCK -> continue to step 1, and return lockTaken:true.
   - LOCK_HELD -> check staleness: if 'started' is missing, unparseable, or more than ${LOCK_STALE_HOURS}
     hours before now, the holder died. Steal it: rm -rf "${sharedLockPath}", then retry the mkdir once.
     Say in 'error' that you broke a stale lock and what it said — a stolen lock must never be silent.
   - Held and FRESH -> return ok:false, with an error naming the holding branch and its start time, and
     the advice: wait for it, or re-run with worktree: true to run in parallel. Do NOT proceed. Do NOT
     remove a fresh lock.
1. Record the starting branch: git rev-parse --abbrev-ref HEAD  -> return it as previousBranch.
2. REFUSE-IF-BASE guard: if the starting branch is already "${taskBranch}", that is fine (idempotent
   re-run) — skip to step 6. The task branch must never equal "${prBase}"; if it somehow does, return
   ok:false with an error.
3. Preserve in-flight work: run 'git status --short'. If there are uncommitted changes, do NOT stash,
   reset, or discard them — a plain 'git switch' carries them across, which is what we want. If a switch
   would genuinely conflict, return ok:false with the exact git error rather than forcing it.
4. Refresh the base: git fetch origin ${prBase}
   (If there is no 'origin' remote or the fetch fails, fall back to the local ${prBase} ref and say so in
   'error' while still returning ok:true — offline is not a blocker.)
5. Create or reuse the branch — this MUST be idempotent, a re-run for the same issue reuses the branch:
   - If the branch already exists locally (git show-ref --verify --quiet refs/heads/${taskBranch}):
       git switch ${taskBranch}          -> created:false
     Do NOT reset or rebase it — it may already hold this task's earlier rounds.
   - Else if it exists on the remote (git ls-remote --exit-code --heads origin ${taskBranch}):
       git switch --track origin/${taskBranch}   -> created:false
   - Else create it from the freshly-fetched base:
       git switch -c ${taskBranch} origin/${prBase}
       (use the local ${prBase} as the start point if origin/${prBase} does not exist)  -> created:true
6. VERIFY, and only then report success. Run: git rev-parse --abbrev-ref HEAD
   - It MUST print exactly "${taskBranch}". If it does not, return ok:false with what it actually printed.
   - It MUST NOT be "${prBase}". If HEAD is still on the base branch, return ok:false — committing there
     is precisely the failure this stage exists to prevent.
   Also return baseSha = git rev-parse --short HEAD.

If you took the lock but then have to return ok:false for any later reason, REMOVE IT
(rm -rf "${sharedLockPath}") before returning — a failed run must not leave the tree locked.

Return ok:true ONLY if HEAD is verifiably on "${taskBranch}". Otherwise ok:false with a concrete error.`,
  { schema: BRANCH_SCHEMA, label: `branch:${taskBranch}`, phase: 'Branch', model: modelFor('branch') }
)

// APL-45: record what we are holding BEFORE the failure check, so a branch stage that took the lock and
// then failed for some later reason still gets it released by blocked() -> releaseIsolation().
if (branchRes && branchRes.lockTaken === true) lockHeld = true

// APL-7 discipline: a null result here means the branch stage never ran — never assume it worked.
if (!branchRes || branchRes.ok !== true || branchRes.branch !== taskBranch) {
  return await blocked({
    status: 'blocked', stage: 'branch', fatal: true,
    blockedReason: !branchRes
      ? `branch manager returned no result — cannot confirm the repo is on "${taskBranch}" (possible API error). Refusing to implement, since work would land on the wrong branch.`
      : `failed to ${useWorktree ? `prepare the worktree for "${taskBranch}"` : `switch to "${taskBranch}"`}: ${branchRes.error || 'branch manager reported ok:false'} (HEAD reported as "${branchRes.branch}")`,
    contractPath: contract,
    branch: taskBranch,
  })
}

// APL-45: the branch stage confirmed the worktree exists and is on the task branch. Redirect every
// subsequent stage into it. This is the ONLY assignment to runCwd — everything downstream reads the
// updated value because the stage prompts are template literals evaluated at call time.
if (useWorktree) {
  activeWorktree = worktreePath
  runCwd = worktreePath
  log(`APL-45: stages now run in ${runCwd} (main checkout ${repoRoot} left untouched on `
      + `"${branchRes.previousBranch || 'its original branch'}").`)
}

// ---------- APL-36: the run has really started — reflect that on the board ----------
// Deliberately AFTER the branch stage: before it, nothing has happened that a human would call "in
// progress", and a run that dies on a bad branch name should not have moved the issue.
linearSync('started', {
  stateType: 'started',
  statePreference: 'In Progress',
  assignSelf: true,
})

// ---------- APL-36: open questions stop the run BEFORE any code is written ----------
// A contract with open questions means the harness does not know what it was asked to build. Guessing
// unattended produces a confident PR for the wrong task, which costs more to review than nothing at all.
// The questions go on the issue (the only channel that reaches a human who is not watching) and the run
// stops clean. args.stopOnOpenQuestions: false implements anyway — the questions are still posted.
if (openQuestions.length) {
  linearSync('open-questions', {
    body: [
      '### The task contract has open questions',
      '',
      'The harness could not contract this task unambiguously. Answer these on the issue (or in the task'
        + ' description) and re-run:',
      '',
      ...openQuestions.map((q) => `- ${q}`),
      '',
      stopOnOpenQuestions
        ? '_The run stopped before writing any code. Nothing was branched into, committed, or opened._'
        : '_The run continued anyway (`stopOnOpenQuestions: false`) — review the resulting PR against these'
          + ' questions before trusting it._',
    ].join('\n'),
  })
  if (stopOnOpenQuestions) {
    return await blocked({
      status: 'blocked', stage: 'contract', openQuestions,
      // APL-47: name the cheap way to resume. The contract stage is the most expensive agent in the run
      // (~180k tokens on opus), and it has ALREADY DONE ITS WORK — the file at contractPath is complete
      // apart from the answers. Re-running with `task` re-authors it from scratch and pays that twice,
      // which is exactly the mistake the first real batch made. Say so here, where the caller reads it.
      blockedReason: `the contract has ${openQuestions.length} open question(s); refusing to implement a guess `
        + `unattended. To resume WITHOUT paying for the contract stage again (~180k tokens): answer the `
        + `questions directly in ${contract}, then re-invoke with contractPath: "${contract}" and `
        + `stopOnOpenQuestions: false — do NOT pass args.task again, that re-authors the contract from scratch.`,
      contractPath: contract,
      branch: taskBranch,
    })
  }
}

// ---------- Stage 2: Implement (re-entered on every fix round; there is no separate repair step) ----------
const taskFiles = new Set()
const fixLog = []
// APL-9: per-loop round counters. fixLog stays a single chronological record (callers read it), but the
// caps are enforced against these, never against fixLog.length.
const gateRounds = () => fixLog.filter((e) => e.stage !== 'review').length
const reviewRounds = () => fixLog.filter((e) => e.stage === 'review').length
let impl = null
let baseline = ''

async function runImplement(feedback) {
  phase('Implement')
  const round = fixLog.length + 1
  const feedbackBlock = feedback && feedback.length
    ? `PREVIOUS ROUNDS FOUND THESE ISSUES — resolve ALL of them with MINIMAL targeted fixes on top of the
existing task diff (already committed rounds stay committed; make a fresh fix on top). Do not touch anything
unrelated and do not reintroduce already-fixed issues:
${feedback.map((i) => `- ${i}`).join('\n')}

`
    : ''
  const baselineBlock = baseline
    ? `PRE-TASK BASELINE (recorded by round 1 — pre-existing uncommitted changes belong to OTHER work; do NOT
touch or report them): ${JSON.stringify(baseline)}

`
    : ''
  return agent(
    `You are the IMPLEMENTER in a strict harness. Repo working dir: ${runCwd}. Task contract: ${contract} (READ IT FIRST).

${baselineBlock}${feedbackBlock}0. FIRST, before any change: run 'git status --short'. ${
  baseline
    ? "Return the pre-task baseline above verbatim as initialGitStatus — do NOT re-record it (round 1 already captured the state before this task)."
    : "Record its exact output verbatim as initialGitStatus. This is the BASELINE — pre-existing uncommitted changes belong to other work and must NOT be touched or reported as yours."
}
1. Read the contract in full. "Allowed paths" and "Files expected to change" define exactly what you may touch.
3. Make the MINIMAL diff that satisfies the contract's Goal and Acceptance checks. Follow repo conventions
   (read AGENTS.md at the repo root).
4. Keep a command journal: append every command you run.
5. Do NOT run the full verification gate (separate stage). Do NOT commit. Do NOT touch forbidden paths,
   generated files, or secrets.
6. NEVER modify the contract file or the gate tooling (dangerfile.js / eslint.config.js /
   .yamllint / package.json), or any test file not listed in the contract. Changing the gate or contract
   to dodge checks is a violation.

If you cannot complete, return status "blocked" with a concrete blockedReason.

Return structured output only.`,
    { schema: IMPLEMENTER_SCHEMA, label: feedback ? `implementer:round-${round}` : 'implementer', phase: 'Implement', model: modelFor('implement') }
  )
}

impl = await runImplement(null)
if (!impl || impl.status === 'blocked') {
  return await blocked({
    status: 'blocked', stage: 'implement',
    blockedReason: impl?.blockedReason || 'implementer failed',
    commandJournal: impl?.commandJournal || [],
  })
}
const initialImpl = impl
baseline = impl.initialGitStatus || ''
for (const f of impl.changedFiles || []) taskFiles.add(f)

// ---------- Stages 3-5: Audit -> Verify -> Review, looping back to implement on any failure ----------

async function runAudit(tag) {
  phase('Audit')
  const a = await agent(
    `You are the AUDITOR in a strict harness. You have NOT seen the implementer's narration — you verify independently.
Repo working dir: ${runCwd}. Task contract: ${contract} (READ IT).

PRE-TASK BASELINE (git status recorded by the implementer BEFORE it made any change):
${JSON.stringify(baseline)}
Any file present in this baseline is PRE-EXISTING work — do NOT flag it. Only audit the DELTA the task introduced.

1. Run: git status --short  and  git diff HEAD  (plus git diff --cached if there are staged changes).
2. Compare ONLY the task-introduced delta (files NOT in the baseline) against the contract:
   - unauthorizedPaths: any file changed outside the contract's "Allowed paths" / not in "Files expected to change"?
   - scopeCreep: changes not needed to satisfy the Goal?
   - secrets: any API key, token, password, .env content, or credential leaked into the diff?
   - contractViolations: any acceptance check the diff clearly does not satisfy? Is the CONTRACT FILE
     itself modified (git status — it must be untouched)? Are the gate tooling (dangerfile.js,
     eslint.config.js, .yamllint, package.json) or non-contract test files modified?
3. Be adversarial. If in doubt, flag it.

Return structured output only.`,
    { schema: AUDIT_SCHEMA, label: `audit:${tag}`, phase: 'Audit', model: modelFor('audit') }
  )
  // APL-7: agent() returns null when the subagent dies on a terminal API error. A null auditor has
  // verified NOTHING — it must never read as clean. Fail hard instead of silently passing the gate.
  if (!a) {
    return {
      audit: null, issues: [], dirty: true, fatal: true,
      fatalReason: `auditor (${tag}) returned no result — the audit did not run, so the diff is UNVERIFIED (possible API error). Refusing to treat an absent audit as clean.`,
    }
  }
  const issues = [
    ...(a.unauthorizedPaths || []),
    ...(a.scopeCreep || []),
    ...(a.secrets || []),
    ...(a.contractViolations || []),
  ]
  // Require an explicit clean === true; anything else (false, or a missing field) is dirty.
  return { audit: a, issues, dirty: a.clean !== true || issues.length > 0, fatal: false }
}

async function runVerify() {
  phase('Verify')
  // The gate is a SCRIPT (${PLUGIN_ROOT}/harness/gate.sh), not a plan. This agent runs one command and
  // reports what it printed.
  //
  // It used to plan the gate every round: read HARNESS.md, decide which checks applied, consolidate
  // them to "<= 6, never more than 10", then run them. That reasoning was paid for on every gate round
  // of every task to reach nearly the same answer each time — and it got the answer wrong in expensive
  // ways (APL-24 and APL-41 each burned both fix rounds on a malformed or repo-wide lint invocation the
  // implementer was forbidden to fix). All of that now lives in the script, where it is fixed once.
  //
  // The agent still exists for the two things a fixed script cannot know: the contract's own
  // task-specific Acceptance commands, and the Swift build/test that gate.sh deliberately excludes.
  //
  // Trust boundary unchanged: the agent reports per-check booleans; the SCRIPT computes allGreen from
  // them, so a summary verdict cannot override a failed check.
  const v = await agent(
    `You are the VERIFY GATE in a strict harness. You observe and report. You do NOT fix, edit or commit.
Repo working dir: ${runCwd} — cd there FIRST. Task contract: ${contract} (READ IT).

## Step 1 — run the gate (one command, always)

  CONTRACT_PATH=${contract} bash ${PLUGIN_ROOT}/harness/gate.sh --fast --base ${prBase}

It prints one line per check and a final 'GATE: PASS|FAIL (n of m)'. Do NOT second-guess it, do NOT
re-run its checks by hand, and do NOT plan a gate of your own — eslint, yamllint, swiftformat, swiftlint,
build, tests and danger are all covered, correctly invoked, and scoped to this task's changed files.
Report ONE entry in 'checks' per 'CHECK <name> ...' line it prints, using its PASS/FAIL verdict.
If a check failed, re-run just that one with '--only <name>' to capture more output for the blocker.

## Step 2 — the contract's own acceptance commands

Read the contract's "Acceptance checks" section. Run any that are concrete shell commands NOT already
covered by step 1 (task-specific greps, node -e structural checks, a scoped test file, and so on).
Issue them as PARALLEL tool calls in one message. Add one 'checks' entry per command.

## Step 3 — Swift build/test, ONLY if apps/macOS/** changed

gate.sh deliberately excludes these: unfiltered xcodebuild is 30+ minutes and needs a suite picked per
diff. From ${runCwd}/apps/macOS:

  xcodegen generate && xcodebuild -project Applygent.xcodeproj -scheme Applygent \\
    -destination 'platform=macOS,arch=arm64' build CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY=""
  xcodebuild ... test ... -only-testing:ApplygentTests/<Suite>    # ONE suite relevant to the diff

The ONLY schemes are 'Applygent', 'Flow' and 'ProgressIndicatorView'. There is NO 'ApplygentTests'
scheme — it is a test TARGET inside 'Applygent'. '-scheme ApplygentTests' fails instantly and the
implementer cannot fix it (project.yml is forbidden), which deadlocks the run.

## Rules

  - passed = true ONLY if the command exited 0. Never infer it from output text ("BUILD SUCCEEDED" in a
    log is not proof of exit 0). gate.sh's own PASS/FAIL lines ARE authoritative — it already handles
    tools that print failure and exit 0.
  - A missing tool/binary is a FAILURE — name it in outputTail.
  - Run everything. A failure does not stop the others. Do NOT retry a failing command in a loop.
  - Do NOT invent a result for a command you did not run. An omitted check is treated as FAILED.

## Report

'checks': one entry per command — name, command (exactly as run), passed, outputTail (last ~30 lines).
'report': the gate.sh output verbatim, plus a one-line verdict per extra check from steps 2-3.
'blockers': a concrete, actionable entry for EVERY failed check — the command, why it failed, what would
fix it. If a failure pre-dates this task (it also fails on the untouched baseline), still report it as
failed and say so explicitly, so the orchestrator can see it is not a regression.

Honesty is the whole point of this stage.`,
    { schema: VERIFY_SCHEMA, label: 'verify-gate', phase: 'Verify', model: modelFor('verify') }
  )

  // APL-7: a null result means the gate never ran — never read that as green.
  if (!v) {
    return {
      checks: [], allGreen: false, report: '', blockers: [], fatal: true,
      fatalReason: 'verify gate returned no result — no checks were planned or run (possible API error). Refusing to pass a gate that never ran.',
    }
  }
  const checks = (v.checks || []).filter((c) => c && c.name)
  if (checks.length === 0) {
    return {
      checks: [], allGreen: false, report: v.report || '', blockers: v.blockers || [], fatal: true,
      fatalReason: 'verify gate reported 0 checks — a gate with no checks cannot be green. Refusing to pass.',
    }
  }
  // The agent's prose verdict is advisory; green is computed here from the per-check booleans.
  const checkOutcomes = checks.map((c) => ({ name: c.name, passed: c.passed === true }))
  const failed = checkOutcomes.filter((c) => !c.passed).map((c) => c.name)
  const blockers = (v.blockers || []).slice()
  if (failed.length > 0 && blockers.length === 0) {
    blockers.push(`checks failed with no blocker detail supplied: ${failed.join(', ')}`)
  }
  return {
    checks: checkOutcomes,
    allGreen: failed.length === 0,
    report: v.report || '',
    blockers,
    fatal: false,
  }
}

// APL-42: Review was the largest stage by a wide margin — 8 of 23 agents on the measured APL-40 run,
// because all four lenses re-read the entire branch diff from scratch on every fix round, with no memory
// of what they had already cleared. Two composed narrowings, both reported, never silent:
//
//   1. SCOPE (rounds >= 2): each lens reads the FIX diff (<last reviewed commit>..HEAD) instead of the
//      whole branch diff. The fix is exactly where a regression would be introduced, so this concentrates
//      attention rather than reducing it. Lenses keep full repo access and are told to open surrounding
//      code when a fix line implicates it — the narrowing is what they are handed by default, not a wall.
//
//   2. LENS SELECTION (rounds >= 2): re-run every lens that had findings last round, plus the lenses in
//      ALWAYS_RERUN_LENSES regardless. A lens that had findings must confirm its own findings are really
//      resolved; the always-run pair covers what a fix can newly break.
//
// Why 'bugs' and 'contract' are the always-run pair: they are the two lenses whose miss ships a defect
// rather than a style problem — a fix is the single most likely source of a new bug, and the fix must
// still satisfy the contract's acceptance checks and touch no forbidden path. 'scope-creep' and
// 'test-gaps' are skippable when they were clean, and their substance is not dropped: on later rounds the
// contract lens is explicitly told to flag files outside the contract's Allowed paths and untested new
// logic in the fix diff. It is a weaker check than an independent lens, which is exactly why every skip
// is named in reviewCoverage, in the notes, and in the log — a review that examined less than it appears
// to is the failure this harness keeps re-learning (APL-7, APL-8, APL-39).
//
// Honest limit: this makes the TYPICAL run cheaper (4 lenses/round -> 2), not the worst case. When every
// lens is live, all four still run — which is the correct answer in that case.
const ALWAYS_RERUN_LENSES = ['bugs', 'contract']

// One entry per review round: what was examined, what was not, and why. Returned in the result.
const reviewCoverage = []

async function runReview(reviewRound, sinceCommit, liveLenses) {
  phase('Review')
  const DIMENSIONS = [
    { key: 'bugs', prompt: 'Hunt for REAL bugs and logic errors in the diff. Only report issues you can point to a concrete line for.' },
    { key: 'scope-creep', prompt: 'Check for edits outside the contract scope, unrelated changes, dead code, or over-engineering.' },
    { key: 'test-gaps', prompt: 'Check whether the changes are covered by tests that would actually fail on regression. Note missing coverage that matters.' },
    { key: 'contract', prompt: 'Check every contract acceptance check against the diff and working tree. Flag any check not actually satisfied, and any forbidden path touched.' },
  ]
  const firstRound = reviewRound === 1
  // Scope narrowing only applies when we actually know where the previous review stopped. Without a
  // commit hash we fall back to the full branch diff rather than guessing at a range.
  const scoped = !firstRound && typeof sinceCommit === 'string' && sinceCommit.length >= 7
  const diffCmd = scoped ? `git diff ${sinceCommit}..HEAD` : `git diff ${prBase}...HEAD`
  const selected = firstRound
    ? DIMENSIONS
    : DIMENSIONS.filter((d) => ALWAYS_RERUN_LENSES.includes(d.key) || (liveLenses || []).includes(d.key))
  const skipped = DIMENSIONS.filter((d) => !selected.includes(d)).map((d) => d.key)

  const coverage = {
    round: reviewRound,
    lensesRun: selected.map((d) => d.key),
    lensesSkipped: skipped,
    diffScope: scoped ? `${sinceCommit}..HEAD (fix diff only)` : `${prBase}...HEAD (full branch diff)`,
    reason: firstRound
      ? 'first review round — full diff, all lenses'
      : `fix round: re-ran the always-run lenses (${ALWAYS_RERUN_LENSES.join(', ')}) plus any lens with findings last round`
        + (scoped ? '; scoped to the fix diff' : '; full branch diff (no previous commit hash to scope from)'),
  }
  reviewCoverage.push(coverage)
  if (skipped.length > 0 || scoped) {
    log(`APL-42 round ${reviewRound}: lenses run [${coverage.lensesRun.join(', ')}]`
        + (skipped.length ? `, NOT re-run [${skipped.join(', ')}] (clean last round)` : '')
        + `, diff scope ${coverage.diffScope}. This round is narrower than a full review — see reviewCoverage.`)
  }

  const lensResults = await parallel(
    selected.map((d) => () =>
      agent(
        `You are a CODE REVIEWER focused on: ${d.key}. Repo working dir: ${runCwd}. Task contract: ${contract} (READ IT).
PRE-TASK BASELINE (git status before this task): ${JSON.stringify(baseline)}
Any file in the baseline is PRE-EXISTING work — ignore it. Review ONLY the task-introduced delta.
Get the diff: git status --short  and  ${diffCmd}  (ignore any uncommitted files not in that diff — they are pre-existing work).
${scoped ? `This is review round ${reviewRound}. The diff above is ONLY the latest FIX, not the whole branch — the
rest of the branch was already reviewed and cleared in an earlier round. Your job is the fix: a regression
the fix introduces is exactly what this round exists to catch. You still have full repo access: when a
changed line implicates surrounding or calling code, OPEN IT and check the interaction. Do not report
issues in unchanged code that this fix did not affect.
` : ''}${d.prompt}
${scoped && d.key === 'contract' ? `Additionally this round (the scope-creep and test-gaps lenses may not be
re-running): flag any file in this fix diff that falls outside the contract's Allowed paths, any change
unrelated to the blocking issues being fixed, and any new logic in the fix that nothing tests.
` : ''}You have NO context from the implementer — judge only what you see in the diff and the contract.
Report concrete findings (file + line + what breaks). Report nothing if clean.`,
        { schema: FINDINGS_SCHEMA, label: `review:${d.key}`, phase: 'Review', model: modelFor(`review:${d.key}`) }
      )
    )
  )
  // APL-7: distinguish "reviewed and found nothing" from "reviewer did not run". A null lens means that
  // dimension was never reviewed — approving on that basis would be a silent pass.
  const deadLenses = selected.filter((d, i) => lensResults[i] == null).map((d) => d.key)
  if (deadLenses.length > 0) {
    return {
      approved: false, fatal: true,
      blockingIssues: [`review lenses produced no result: ${deadLenses.join(', ')}`],
      confirmed: [], notes: '',
      fatalReason: `review lenses did not run: ${deadLenses.join(', ')} — those dimensions are UNREVIEWED (possible API error). Refusing to approve an unreviewed diff.`,
    }
  }
  // Tag each finding with its lens: the next round re-runs any lens that is still live.
  const rawFindings = lensResults.flatMap((r, i) => (r.findings || []).map((f) => ({ ...f, lens: selected[i].key })))
  const nextLiveLenses = selected.filter((d, i) => (lensResults[i].findings || []).length > 0).map((d) => d.key)

  // APL-8: one refuter agent per finding was the ~1M-token burn; the round is capped and blocking
  // findings go first. This narrows it further: ONLY blocking findings are refuted.
  //
  // Refutation exists to stop a plausible-but-wrong finding from sending the implementer to fix
  // nothing. That risk is carried entirely by findings that can BLOCK. A non-blocking nit costs an
  // agent (~39k tokens) to adversarially verify and then changes nothing either way — on the APL-48
  // review, all 5 findings were non-blocking and 5 refuters ran to confirm 4 of them, for no effect
  // on the verdict.
  //
  // Non-blocking findings are NOT dropped. They pass through unrefuted and are marked as such, so the
  // synthesizer cannot present them as adversarially verified.
  const blockingRaw = rawFindings.filter((f) => f.severity === 'blocking')
  const nonBlocking = rawFindings.filter((f) => f.severity !== 'blocking').map((f) => ({ ...f, unrefuted: true }))
  const allFindings = blockingRaw.slice(0, MAX_REFUTERS_PER_ROUND)
  const droppedFindings = blockingRaw.slice(MAX_REFUTERS_PER_ROUND)
  if (droppedFindings.length > 0) {
    // Never silent: a truncated review must not read as "reviewed everything". Every dropped finding
    // here is blocking by construction, which is the worst kind to drop.
    log(`APL-8 cap: ${blockingRaw.length} BLOCKING findings exceeded MAX_REFUTERS_PER_ROUND=${MAX_REFUTERS_PER_ROUND}; ` +
        `${droppedFindings.length} left unverified (all of them blocking): ` +
        droppedFindings.map((f) => `${f.file}: ${f.title}`).join(' | '))
  }
  if (nonBlocking.length > 0) {
    log(`Refuting ${allFindings.length} blocking finding(s); ${nonBlocking.length} non-blocking finding(s) ` +
        `carried through UNREFUTED (they cannot block, so adversarial verification changes nothing).`)
  }

  const verdicts = await parallel(
    allFindings.map((f) => () =>
      agent(
        `You are an adversarial VERIFIER. A reviewer claimed this issue. Try to REFUTE it.
Repo working dir: ${runCwd} — cd there FIRST. Every path below is relative to it.
Title: ${f.title}
Description: ${f.description}
File: ${f.file}${f.line ? ':' + f.line : ''}
Severity: ${f.severity}

Re-read the relevant file/diff. isReal = true only if you cannot refute it (or can reproduce it).
When in doubt, default to isReal = false.

APL-45: that default makes reading the WRONG tree indistinguishable from a refuted finding — an
unmodified copy of the file refutes everything. So if you cannot find the file under ${runCwd}, or the
diff there does not contain the change under review, do NOT return isReal:false. Return isReal:true with
a reason saying you could not read the file, so a real finding is never dropped by a path mistake.`,
        { schema: VERDICT_SCHEMA, label: `refute:${(f.file || '?').split('/').pop()}`, phase: 'Review', model: modelFor('refute') }
      )
    )
  )
  // A null verdict means the refuter never ran — keep the finding rather than dropping it silently.
  const confirmedBlocking = allFindings.filter((f, i) => verdicts[i] == null || verdicts[i].isReal === true)
  // Non-blocking findings were never refuted, so they are appended AFTER the verified ones and carry
  // `unrefuted: true`. Order matters: anything reading the head of this list gets the verified items.
  const confirmed = [...confirmedBlocking, ...nonBlocking]

  const synth = await agent(
    `You are the REVIEW SYNTHESIZER. Task contract: ${contract}. Repo: ${runCwd}.
This is review round ${reviewRound}. Lenses run this round: ${coverage.lensesRun.join(', ')}.${skipped.length
      ? ` NOT re-run this round (they were clean on the previous, larger diff): ${skipped.join(', ')} — say so in
notes, so nobody reads this verdict as a fresh four-lens review.` : ''}
Diff examined: ${coverage.diffScope}.
Review findings. A [blocking] entry survived an adversarial refuter that tried to disprove it. A
[non-blocking, UNREFUTED] entry did NOT: only blocking findings are refuted, because a nit costs an
agent to verify and changes no verdict either way. Treat an unrefuted entry as a reviewer's claim,
not as established fact — do NOT promote one to blocking without checking it yourself first.
${confirmed.map((f) => `- [${f.severity}${f.unrefuted ? ', UNREFUTED' : ''}] ${f.file}${f.line ? ':' + f.line : ''}: ${f.title} — ${f.description}`).join('\n') || '(none)'}

Decide:
- approved = true ONLY if there are no blocking issues (bugs that break the goal, security issues, contract
  violations, or scope creep that must be fixed). Nits and deferrable items are non-blocking.
- blockingIssues = the confirmed findings that must block (human-readable).
- notes = non-blocking observations + a 2-line summary of the diff.`,
    { schema: SYNTH_SCHEMA, label: 'synthesis', phase: 'Review', model: modelFor('synthesis') }
  )

  if (!synth) {
    return {
      approved: false, fatal: true,
      // Only blocking findings may become blockers — `confirmed` now also carries unrefuted nits.
      blockingIssues: confirmedBlocking.map((f) => `${f.file}: ${f.title}`),
      confirmed, notes: '',
      fatalReason: 'review synthesizer returned no result — the review verdict is unknown (possible API error). Refusing to assume approval.',
    }
  }
  const coverageNote = skipped.length > 0 || scoped
    ? `\n\nNOTE (APL-42 narrowing): this round examined ${coverage.diffScope}`
      + (skipped.length ? ` and did NOT re-run these lenses: ${skipped.join(', ')} (clean on the previous, larger diff).` : '.')
      + ' It is narrower than the first round — see reviewCoverage.'
    : ''
  const truncationNote = droppedFindings.length > 0
    ? `\n\nNOTE (APL-8 cap): ${droppedFindings.length} further finding(s) were NOT verified this round ` +
      `because the ${MAX_REFUTERS_PER_ROUND}-refuter cap was reached. This review is not exhaustive.`
    : ''
  return {
    approved: synth.approved === true,
    blockingIssues: synth.blockingIssues || confirmedBlocking.map((f) => `${f.file}: ${f.title}`),
    confirmed,
    notes: (synth.notes || '') + truncationNote + coverageNote,
    droppedFindings: droppedFindings.map((f) => `${f.file}: ${f.title}`),
    liveLenses: nextLiveLenses,
    coverage,
    fatal: false,
  }
}

let auditRes = await runAudit('round-1')
let verifyRes = null
let exhausted = false
// APL-37: set when a loop stopped for BUDGET rather than for rounds — a different failure with a
// different remedy, and one the result must not blur into "the fix rounds ran out".
let budgetStopped = false
const commitLog = []

// ---------- Pre-commit gate: Audit -> Verify, looping back to implement until clean ----------
while (true) {
  // APL-7: a fatal stage (an agent that never ran) is NOT a fixable issue — looping back to the
  // implementer cannot repair an API error. Abort loudly instead of burning fix rounds or passing.
  if (auditRes.fatal) {
    return await blocked({ status: 'blocked', stage: 'audit', fatal: true, blockedReason: auditRes.fatalReason, fixLog })
  }
  if (auditRes.dirty) {
    if (gateRounds() >= gateFixMax) { exhausted = true; break }
    if (budgetExhausted()) {
      log(`APL-37: stopping gate-fix rounds — ${Math.round(budget.remaining() / 1000)}k tokens remain, below `
          + `the ${BUDGET_FLOOR / 1000}k floor. The diff is NOT committed and no PR was opened.`)
      budgetStopped = true
      exhausted = true
      break
    }
    impl = await runImplement(auditRes.issues)
    if (!impl || impl.status === 'blocked') {
      return await blocked({ status: 'blocked', stage: 'implement', blockedReason: impl?.blockedReason || 'implementer failed on fix round', fixLog })
    }
    for (const f of impl.changedFiles || []) taskFiles.add(f)
    fixLog.push({ stage: 'audit', issues: auditRes.issues, fix: impl })
    auditRes = await runAudit('round-' + (fixLog.length + 1))
    continue
  }
  verifyRes = await runVerify()
  if (verifyRes.fatal) {
    return await blocked({ status: 'blocked', stage: 'verify', fatal: true, blockedReason: verifyRes.fatalReason, fixLog })
  }
  if (!verifyRes.allGreen) {
    if (gateRounds() >= gateFixMax) { exhausted = true; break }
    if (budgetExhausted()) {
      log(`APL-37: stopping gate-fix rounds — ${Math.round(budget.remaining() / 1000)}k tokens remain, below `
          + `the ${BUDGET_FLOOR / 1000}k floor. The diff is NOT committed and no PR was opened.`)
      budgetStopped = true
      exhausted = true
      break
    }
    impl = await runImplement(verifyRes.blockers)
    if (!impl || impl.status === 'blocked') {
      return await blocked({ status: 'blocked', stage: 'implement', blockedReason: impl?.blockedReason || 'implementer failed on fix round', fixLog })
    }
    for (const f of impl.changedFiles || []) taskFiles.add(f)
    fixLog.push({ stage: 'verify', issues: verifyRes.blockers, fix: impl })
    auditRes = await runAudit('round-' + (fixLog.length + 1))
    continue
  }
  break
}

if (exhausted) {
  const last = auditRes?.dirty ? { stage: 'audit', issues: auditRes.issues } : { stage: 'verify', issues: verifyRes?.blockers }
  return await blocked({
    status: 'blocked', stage: last.stage, terminal: 'no-pr',
    roundsExhausted: !budgetStopped, budgetStopped, fixMax: gateFixMax, gateFixMax, reviewFixMax, fixLog,
    lastFailure: last,
    changedFiles: [...taskFiles],
    summary: impl.summary,
    commandJournal: [...(initialImpl.commandJournal || []), ...fixLog.flatMap((e) => e.fix?.commandJournal || [])],
    audit: auditRes?.audit,
    report: verifyRes?.report,
  })
}

// ---------- Commit + push (initial commit and every review-fix round) ----------
async function commitStage(label) {
  phase('Commit')
  return agent(
    `You are the COMMITTER in a strict harness. Repo working dir: ${runCwd}. Task contract: ${contract}.
1. git status --short  and  git diff --stat
2. The task's changed files are: ${[...taskFiles].join(' ')}. Stage exactly the ones git status shows as
   changed (staged or unstaged) — git add <each such file>. NEVER git add -A or git add . blindly. Do NOT
   stage any pre-existing unrelated uncommitted changes (the pre-task baseline).
3. Verify the staged set is limited to the task's files. Commit with a message summarizing WHY the change
   was made, matching the repo's git log style (run: git log --oneline -5).${issueId ? ` Put the issue key
   ${issueId} in the subject line, in parentheses, so the history is traceable to the tracker.` : ''} Include the trailer line:
   Co-Authored-By: Claude <noreply@anthropic.com>
4. Push: git push -u origin HEAD  (a failed push is a failure — report it).

Return commitHash + committedFiles + message + pushed (pushed = true ONLY if the push succeeded).`,
    { schema: COMMIT_SCHEMA, label: 'committer:' + label, phase: 'Commit', model: modelFor('commit') }
  )
}

async function openPR() {
  phase('PR')
  return agent(
    `You are the PR OPENER in a strict harness. Repo working dir: ${runCwd}. Task contract: ${contract} (READ IT).
The task's changes are committed and pushed on the current branch.
1. Confirm: git status  and  git rev-parse --abbrev-ref HEAD  and  git log --oneline -3
2. Open a pull request into base "${prBase}":
   gh pr create --base ${prBase} --title "<short title from the contract Goal>" --body "<body>"
   Body: the contract's Goal (1-2 lines)${issueId ? `, the line "Closes ${issueId}."` : ''} plus the line
   "Generated by the task harness — do NOT merge without review."
3. If the branch already has a PR, reuse it (gh pr view --head "$(git rev-parse --abbrev-ref HEAD)" --json number,url --jq '.number + " " + .url') — never create a duplicate.
4. If gh is unavailable or creation fails, set prUrl: '' with a short note — the branch is pushed and the
   diff is reviewable; the PR can be opened manually.

Return prUrl + prNumber (+ note if any).`,
    { schema: PR_SCHEMA, label: 'pr-opener', phase: 'PR', model: modelFor('pr') }
  )
}

// ---------- Stage: Commit (first) ----------
let commit = null
if (noCommit) {
  commit = { skipped: true, reason: 'noCommit set — diff left uncommitted for review' }
} else {
  commit = await commitStage('initial')
  if (!commit || !commit.pushed) {
    return await blocked({ status: 'blocked', stage: 'commit', blockedReason: 'initial commit or push failed', fixLog })
  }
  commitLog.push(commit)
}

// ---------- Stage: Open PR ----------
let pr = null
if (!noCommit) {
  pr = await openPR()
  // APL-36: attach the PR and move the issue to In Review. Only on a real URL — a failed `gh pr create`
  // returns prUrl: '' and must not leave the board claiming a PR exists.
  if (pr?.prUrl) {
    linearSync('pr-opened', {
      stateType: 'started',
      statePreference: 'In Review',
      links: [{ url: pr.prUrl, title: `PR${pr.prNumber ? ' #' + pr.prNumber : ''} — ${linearKey || contractSlug}` }],
    })
  } else {
    log('APL-36: no PR URL returned — skipping the Linear PR write rather than reporting a PR that does not exist.')
  }
}

// ---------- Stage: Review (post-commit, against the pushed diff) ----------
// Review runs AFTER the PR is open. Blocking issues loop back to IMPLEMENT; each fix round is committed
// and pushed to the same PR, then re-reviewed. The review's own lenses (bugs / scope-creep / test-gaps /
// contract) cover contract compliance, so fix rounds skip a separate audit.
// APL-8: the review stage is the most expensive fan-out in the run. If the turn's budget is nearly
// spent, stop cleanly and say so rather than dying mid-fan-out with a half-finished review.
let reviewRes = null
if (!noCommit && budgetExhausted()) {
  log(`APL-8: skipping Review — ${Math.round(budget.remaining() / 1000)}k tokens remain, below the ` +
      `${BUDGET_FLOOR / 1000}k floor. The diff is committed and the PR is open, but it is UNREVIEWED.`)
} else if (!noCommit) {
  // APL-42: the fix diff for round N is <the commit reviewed in round N-1>..HEAD. Tracking the hash here
  // (rather than asking an agent to work the range out) keeps the scoping deterministic; if a commit
  // stage ever fails to report a hash, `scoped` falls back to the full branch diff and says so.
  let reviewRound = 1
  let lastReviewedCommit = commit?.commitHash || ''
  reviewRes = await runReview(reviewRound, '', [])
  if (reviewRes.fatal) {
    return await blocked({ status: 'blocked', stage: 'review', fatal: true, blockedReason: reviewRes.fatalReason, fixLog, pr, commits: commitLog, reviewCoverage })
  }
  while (!reviewRes.approved) {
    if (reviewRounds() >= reviewFixMax) { exhausted = true; break }
    if (budgetExhausted()) {
      log(`APL-8: stopping review-fix rounds — ${Math.round(budget.remaining() / 1000)}k tokens remain, ` +
          `below the ${BUDGET_FLOOR / 1000}k floor. Blocking issues remain UNFIXED.`)
      budgetStopped = true
      exhausted = true
      break
    }
    impl = await runImplement(reviewRes.blockingIssues)
    if (!impl || impl.status === 'blocked') {
      return await blocked({ status: 'blocked', stage: 'implement', blockedReason: impl?.blockedReason || 'implementer failed on review fix round', fixLog, pr })
    }
    for (const f of impl.changedFiles || []) taskFiles.add(f)
    fixLog.push({ stage: 'review', issues: reviewRes.blockingIssues, fix: impl })
    const fixCommit = await commitStage('fix-round-' + fixLog.length)
    if (!fixCommit || !fixCommit.pushed) {
      return await blocked({ status: 'blocked', stage: 'commit', blockedReason: 'fix-round commit or push failed', fixLog, pr })
    }
    commitLog.push(fixCommit)
    reviewRound += 1
    const sinceCommit = lastReviewedCommit
    lastReviewedCommit = fixCommit.commitHash || lastReviewedCommit
    reviewRes = await runReview(reviewRound, sinceCommit, reviewRes.liveLenses || [])
    if (reviewRes.fatal) {
      return await blocked({ status: 'blocked', stage: 'review', fatal: true, blockedReason: reviewRes.fatalReason, fixLog, pr, commits: commitLog, reviewCoverage })
    }
  }
  if (exhausted) {
    return await blocked({
      status: 'blocked', stage: 'review', terminal: terminalState(pr),
      roundsExhausted: !budgetStopped, budgetStopped, fixMax: reviewFixMax, gateFixMax, reviewFixMax, fixLog, reviewCoverage,
      lastFailure: { stage: 'review', issues: reviewRes?.blockingIssues },
      changedFiles: [...taskFiles],
      summary: impl.summary,
      commandJournal: [...(initialImpl.commandJournal || []), ...fixLog.flatMap((e) => e.fix?.commandJournal || [])],
      pr,
    })
  }
}

// ---------- Stage: Follow-ups (triage, then file) ----------
// The implementer is asked to record out-of-scope defects it finds under the contract's "## Follow-ups"
// rather than fixing them (that would be the scope creep the auditor rejects). Two things then went
// wrong in practice. Nothing in the run FILED them, so the list died with the contract — which is
// gitignored, so "written down" meant "lost". And the review's contract lens treats a confirmed defect
// that was neither fixed nor filed as BLOCKING, so a run that found anything real could not pass its own
// review: the process was unsatisfiable by construction (APL-54 ended by asking a human to file by hand).
//
// This stage closes that. It is deliberately a SEPARATE, cheap agent rather than more work for the
// implementer: the implementer is the party with an interest in its own list surviving, and asking it to
// judge its own follow-ups is asking the author to review the author. A haiku reads one section, applies
// three rules, and runs a script whose output says exactly what was filed — the script, not the model,
// is what talks to Linear, so a hallucinated issue URL cannot reach the report.
let followups = null
if (!noCommit) {
  phase('Follow-ups')
  followups = await agent(
    `You are the FOLLOW-UP TRIAGER in a strict harness. Working dir: ${runCwd}. Contract: ${contract}.

The contract may carry a "## Follow-ups" section — out-of-scope problems the implementer found and
deliberately did NOT fix. Your job is to decide which deserve a Linear issue, and to file them.

1. Read the "## Follow-ups" section of the contract. If it is absent or empty, return everything empty
   with note: "none recorded" and do NOT run anything else.
2. Judge each entry against these three rules (from ${PLUGIN_ROOT}/harness/HARNESS.md):
   - VERIFIED ONLY — you can point at the file:line and say what is wrong. A hunch, a "we should
     probably", or a refactor opinion is not a follow-up. Open the file and CHECK; do not take the
     entry's word for it.
   - LOSABLE ONLY — filing is for what would otherwise be forgotten. Something already covered by an
     existing issue, an obvious TODO in the code, or a thing this PR's reviewer will plainly see is not.
   - AT MOST 3 — if more than three survive, keep the three with the highest chance of causing a real
     defect and drop the rest. Needing a fourth means the contract's scope was wrong, which is worth
     saying in \`note\` rather than filing around.
3. Rewrite the contract's "## Follow-ups" section IN PLACE so it contains exactly the survivors, one
   markdown bullet each, first line = a title under 120 chars naming the file. Leave the rest of the
   contract byte-identical — the auditor checks that the contract file is otherwise unchanged.
4. File them:  bash ${PLUGIN_ROOT}/harness/file-followups.sh ${contract} ${issueId || 'NONE'}
   The script searches Linear first and prints one line per entry: FILED <key/url>, SKIP (already
   filed), or FAIL. It files into Triage, because these are agent-proposed and want a human pass.
5. Report what the SCRIPT printed, not what you intended. \`filed\` = the FILED/SKIP lines verbatim.
   Any FAIL line goes in \`failed\` — an unfiled follow-up is the exact loss this stage exists to
   prevent, so it must be visible, never rounded down to a pass.

Never fail the task over Linear: if the script cannot reach it, put the error in \`failed\` and return
normally. Do not fix any of the underlying problems — filing them is the entire job.`,
    { schema: FOLLOWUPS_SCHEMA, label: 'followups', phase: 'Follow-ups', model: modelFor('followups') }
  )
  if (followups?.failed?.length) {
    log(`Follow-ups: ${followups.failed.length} entr(ies) could NOT be filed — they are in the result and `
        + `in the Linear comment, but nothing is tracking them: ${followups.failed.join('; ')}`)
  }
}

// ---------- APL-36: approved — post the outcome on the issue ----------
// The issue is left In Review, not Done: the harness never merges, so only the human who merges can
// honestly close it.
if (!noCommit) {
  linearSync('approved', {
    body: [
      reviewRes ? '### Harness run complete — review APPROVED' : '### Harness run complete — PR open, NOT reviewed',
      '',
      `**Branch:** \`${taskBranch}\``,
      pr?.prUrl ? `**PR (open, NOT merged):** ${pr.prUrl}` : '**PR:** not opened — the branch is pushed and reviewable.',
      `**Files changed:** ${[...taskFiles].join(', ') || 'none recorded'}`,
      '',
      '**Gate report:**',
      '',
      verifyRes?.report ? '```\n' + String(verifyRes.report).slice(0, 2000) + '\n```' : '_no gate report recorded_',
      '',
      fixLog.length ? `**Fix rounds:**\n${fixLogDigest(fixLog)}` : '_Clean on the first round._',
      // The filed follow-ups belong on the issue, not only in a tool result the human never opens.
      followups?.filed?.length
        ? `\n**Follow-ups filed (Triage):**\n${followups.filed.map((f) => `- ${f}`).join('\n')}`
        : '',
      followups?.failed?.length
        ? `\n> **${followups.failed.length} follow-up(s) could NOT be filed** and nothing is tracking them:`
          + ` ${followups.failed.join('; ')}`
        : '',
      reviewRes ? '' : '\n> **This PR was NOT reviewed** — the review stage was skipped (token budget floor).'
        + ' Review it manually before merging.',
      (reviewRes?.droppedFindings || []).length
        ? `\n> **${reviewRes.droppedFindings.length} review finding(s) were dropped by the fan-out cap** and never`
          + ` verified: ${reviewRes.droppedFindings.slice(0, 10).join('; ')}`
        : '',
      '',
      '_Posted by the task harness. Merging is still yours — the harness never merges._',
    ].filter((l) => l !== '').join('\n'),
  })
}

// APL-45: last thing before returning. On a clean run the branch is pushed and the PR is open, so the
// worktree holds nothing that is not also on the remote and can go. Note the ordering: this runs AFTER
// the PR is confirmed open, never before — removing the worktree first would delete the very commits the
// push is meant to carry if the push turned out to have failed.
const cleanupNote = await releaseIsolation('done')

return {
  status: 'done',
  stage: noCommit || (commit && commit.skipped) ? 'pre-commit' : 'commit',
  // APL-45: null once the worktree is gone; a path means it is still on disk and why.
  worktree: activeWorktree,
  lockHeld,
  cleanupNote,
  // APL-37 req 4: 'pr-opened' or 'no-pr', never left for the caller to guess. A done run with terminal
  // 'no-pr' is a real outcome (noCommit, or `gh` unavailable) — not a silent success.
  terminal: terminalState(pr),
  unattended,
  approved: true,
  contractPath: contract,
  branch: taskBranch,
  branchCreated: branchRes.created === true,
  changedFiles: [...taskFiles],
  summary: impl.summary,
  commandJournal: [...(initialImpl.commandJournal || []), ...fixLog.flatMap((e) => e.fix?.commandJournal || [])],
  audit: auditRes.audit,
  report: verifyRes.report,
  confirmed: reviewRes?.confirmed || [],
  notes: reviewRes?.notes || '',
  // APL-8: non-empty when a cap stopped the review short — the caller must not read this run as
  // having reviewed everything. reviewSkipped is true when the budget floor skipped Review entirely.
  droppedFindings: reviewRes?.droppedFindings || [],
  reviewSkipped: !noCommit && reviewRes == null,
  // APL-42: one entry per review round — which lenses ran, which were not re-run, and what diff each
  // round examined. A later round is deliberately narrower than the first; this is where that is stated.
  reviewCoverage,
  // What the triager kept, dropped and actually filed. `failed` non-empty means a real defect is
  // untracked — the caller must not read the run as having lost nothing.
  followups,
  fixLog,
  commit,
  commits: commitLog,
  pr,
  // The Linear writes the CALLER must perform, in order. The workflow no longer spends an agent on
  // these — see HARNESS.md -> Linear round-trip. If the caller does not perform them, the board is
  // stale and nobody was told: that is the caller's obligation, not a silent harness failure.
  linearWrites,
}
