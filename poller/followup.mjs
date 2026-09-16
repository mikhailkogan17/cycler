// After the run: what happens to a dispatched session once its PR exists.
//
//   PR merged or closed          → stop the session (the CLI's closest thing to archiving: the
//                                  conversation is kept, `claude attach <id>` still opens it) and
//                                  stop following the issue.
//   new human comment on the PR  → resume the session with the links, so it addresses them.
//   new human comment on Linear  → the same. This is how a reply to a "waiting for your reply"
//                                  comment reaches the session without anyone opening it.
//
// Every dependency is a parameter: this runs against gh, the claude CLI and Linear, and none of those
// belong in a test.

// Comments the agent side wrote itself. gh posts as the same account a human uses, so authorship
// cannot tell them apart; the attribution line every agent-written GitHub text carries can.
const AGENT_BODY_RE = /Generated with \[?Claude Code|Co-Authored-By: Claude/i;

function isHumanGithub(c, since) {
  const login = String(c?.user?.login || c?.author?.login || '');
  if (!login || /\[bot\]$/.test(login) || c?.user?.type === 'Bot' || login === 'linear-code') return false;
  if ((Date.parse(c.created_at || c.submitted_at || c.createdAt || c.submittedAt) || 0) <= since) return false;
  return !AGENT_BODY_RE.test(String(c.body || ''));
}

// Linear: an app comment has a botActor; a person's has a user and none.
function isHumanLinear(c, since) {
  return Boolean(c && c.user && !c.botActor && (Date.parse(c.createdAt) || 0) > since);
}

function followupPrompt(identifier, pr, links) {
  return `New feedback on ${identifier}${pr ? ` (PR #${pr})` : ''} since you last worked it:\n`
    + links.map((l) => `- ${l}`).join('\n')
    + `\nRead each one. If it asks for a change, make it on the same branch, run the gate, commit and push. `
    + `If it answers a question you asked, continue from there. Do not open a second PR or branch, and post `
    + `nothing on the Linear issue.`;
}

// deps: { prFor(identifier) → {number,state,url,comments[]} | null, isWorking(session) → bool,
//         resume(session, prompt, identifier) → newSession, stop(session), comment(issueId, body),
//         link(session) → markdown, log(...) }
async function followUp(issues, registry, deps, now = Date.now()) {
  const next = {};
  for (const issue of issues) {
    const rec = registry[issue.id];
    if (!rec || !rec.session) continue;
    let pr = null;
    try { pr = deps.prFor(issue.identifier); } catch (err) { deps.log(`${issue.identifier}: PR lookup failed: ${err.message}`); }
    if (pr && ['MERGED', 'CLOSED'].includes(pr.state)) {
      try { deps.stop(rec.session); } catch { /* already stopped */ }
      deps.log(`${issue.identifier} PR #${pr.number} ${pr.state.toLowerCase()} — session ${rec.session} stopped, no longer followed`);
      continue;
    }
    const since = Number(rec.seenAt) || 0;
    const links = [
      ...(pr?.comments || []).filter((c) => isHumanGithub(c, since)).map((c) => c.html_url || c.url || pr.url),
      ...(issue.comments?.nodes || []).filter((c) => isHumanLinear(c, since))
        .map((c) => `Linear comment: ${String(c.body || '').replace(/\s+/g, ' ').slice(0, 300)}`),
    ];
    if (!links.length || deps.isWorking(rec.session)) { next[issue.id] = rec; continue; }
    try {
      const session = deps.resume(rec.session, followupPrompt(issue.identifier, pr?.number, links), issue.identifier);
      next[issue.id] = { ...rec, session, seenAt: now };
      deps.log(`${issue.identifier} resumed for ${links.length} new comment(s) — session ${session}`);
      try {
        await deps.comment(issue.id, `Resumed by cycler for new review comments — session ${deps.link(session)}.`);
      } catch (err) { deps.log(`${issue.identifier}: could not comment: ${err.message}`); }
    } catch (err) {
      deps.log(`${issue.identifier}: follow-up resume failed, retrying next poll: ${err.message}`);
      next[issue.id] = rec;
    }
  }
  // Issues no longer delegated keep their record untouched: the list is paged, not authoritative.
  for (const [id, rec] of Object.entries(registry)) if (!issues.some((i) => i.id === id)) next[id] = rec;
  return next;
}

export { followUp, followupPrompt, isHumanGithub, isHumanLinear };
