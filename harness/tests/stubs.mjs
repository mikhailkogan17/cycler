// Shared stage responder: a scripted "run" where each stage's verdict is
// controlled per round, so we can drive the exact path an issue describes.
export function makeResponder(plan = {}) {
  // plan.auditDirty:     array of booleans per audit call
  // plan.verifyGreen:    array of booleans per verify call
  // plan.reviewApproved: array of booleans per synthesis call
  // plan.findings:       findings every review lens returns, every round (simple cases)
  // plan.lensFindings:   { <lens>: [ [round1 findings], [round2 findings], ... ] } — per lens, per round
  // plan.contract:       override the contract stage result (e.g. to inject openQuestions)
  // plan.pr:             override the PR stage result; null means `gh pr create` failed
  const n = { audit: 0, verify: 0, synth: 0, commit: 0 }
  const lensRound = {}
  return async (label) => {
    if (label === 'contract') return plan.contract || { contractPath: '/tmp/c.md', slug: 'demo' }
    // plan.branch overrides the whole branch result (e.g. ok:false for a lock already held).
    // plan.lockTaken makes the shared-tree run report that it took the lock, so cleanup has work to do.
    if (label.startsWith('branch:')) {
      if (plan.branch !== undefined) return plan.branch
      return { ok: true, branch: label.slice('branch:'.length), created: true, lockTaken: plan.lockTaken === true }
    }
    // APL-45 cleanup. plan.cleanup === null simulates the agent dying (a null result).
    if (label === 'cleanup') {
      if (plan.cleanup === null) return null
      return plan.cleanup || { lockReleased: true, worktreeRemoved: true, note: 'released' }
    }
    if (label.startsWith('implementer')) return { status: 'done', initialGitStatus: '', changedFiles: ['a.ts'], summary: 's', commandJournal: [] }
    if (label.startsWith('audit:')) {
      const dirty = (plan.auditDirty || [])[n.audit++] === true
      return { clean: !dirty, unauthorizedPaths: [], scopeCreep: [], missingAcceptance: dirty ? ['x'] : [], secrets: [], notes: '' }
    }
    if (label === 'verify-gate') {
      const green = (plan.verifyGreen || [])[n.verify++] !== false
      return { allGreen: green, checks: [{ name: 'build', command: 'npm test', passed: green, outputTail: '' }], blockers: green ? [] : ['gate red'], report: 'gate report' }
    }
    if (label.startsWith('review:')) {
      // Per-lens, per-round findings when the test cares which lens ran (APL-42); otherwise the same
      // findings from every lens on every round.
      const lens = label.slice('review:'.length)
      const r = (lensRound[lens] = (lensRound[lens] || 0) + 1)
      if (plan.lensFindings) return { findings: (plan.lensFindings[lens] || [])[r - 1] || [] }
      return { findings: plan.findings || [] }
    }
    if (label.startsWith('refute:')) return { isReal: true, reason: 'r' }
    if (label === 'synthesis') {
      const ok = (plan.reviewApproved || [])[n.synth++] === true
      return { approved: ok, blockingIssues: ok ? [] : ['review blocker'], confirmed: [], notes: 'synth notes' }
    }
    // A distinct hash per commit: APL-42 scopes each review round to <previous commit>..HEAD.
    if (label.startsWith('committer:')) return { commitHash: `commit${++n.commit}0000000`, committedFiles: ['a.ts'], message: 'm', pushed: true }
    // Cheap by default: a run with no follow-ups recorded is the common case, and a test that cares
    // passes plan.followups explicitly.
    if (label === 'followups') return plan.followups || { kept: [], dropped: [], filed: [], failed: [], note: 'none recorded' }
    if (label === 'pr-opener') return plan.pr === null ? { prUrl: '' } : (plan.pr || { prUrl: 'https://gh/pr/1', prNumber: '1' })
    // Linear writes are no longer agents — the workflow plans them into result.linearWrites and the
    // orchestrator performs them. A `linear:` label reaching here means that regressed.
    throw new Error('unstubbed label: ' + label)
  }
}
