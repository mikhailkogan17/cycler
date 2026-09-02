# 0001 — Poll Linear outbound instead of receiving webhooks

**Status:** Accepted
**Date:** 2026-09

## Context

Linear's agent integration delivers events by **webhook**. A webhook needs a URL Linear can reach.
A developer's laptop does not have one.

Every existing option resolves this the same way: run the networking layer in the vendor's cloud and
have it relay to the local agent, or have the user tunnel — ngrok, Hookdeck — into their machine. In
both cases "self-hosted" means the agent process is local while the thing that makes it reachable is
not, and there is a service to sign up for.

The target user was stated plainly: solo devs who want this loop without paying for a platform.

## Decision

Poll outbound. A launchd job runs a plain Node script every 180 seconds; it queries the Linear
GraphQL API for issues delegated to an OAuth app **in the user's own workspace** and dispatches a
background Claude Code session for each new one.

Nothing listens on the machine. There is no cycler account, no cycler server, and no tunnel.

## Consequences

**Worse:** up to 180 seconds of latency between delegating an issue and the session starting. For
work that takes 10–40 minutes, this is noise; `/cycler:start <KEY>` forces a poll when it is not.

**Worse:** the machine must be awake. launchd runs a missed job once on wake, so a closed laptop
delays dispatch rather than losing it, but a machine that is off dispatches nothing.

**Better:** no inbound attack surface, no third party in the path of your issue tracker, and no
subscription. The poller never calls a model, so the loop's only token cost is the workflow the user
configured — which matters when the user was chosen for being poor.

**Better:** the failure modes are all local and inspectable. `poller.log`, `launchctl list`, and one
`node poller/poller.mjs` reproduce the whole trigger half.

## What would change this

If Linear shipped a first-party outbound-polling agent API, or a relay that did not require an
account, the poller stops being a differentiator and becomes maintenance. Equally, if 180s latency
turned out to matter for the actual work, the trade would need revisiting — but that would be an
argument for a shorter interval before it was an argument for webhooks.
