#!/usr/bin/env bash
# harness/contract-section.sh — read one section's declared paths out of a contract.
#
#   contract_section <contract-path> <section-name>
#
# ONE implementation, sourced by audit.sh and require-escape-hatch.sh. There were two, and they
# drifted: audit.sh was fixed to read only bullet lines, the escape-hatch hook was not, and its
# comment claimed it counted "the same way audit.sh does" while counting differently. A contract
# listing 3 files was counted as 22 and the run waived its own escape hatch to get past the false
# positive — a safety mechanism disabled by its own bug.
#
# Two rules, both learned from false positives:
#
# 1. Only BULLET lines are declarations. A section also contains prose, and good prose contains
#    backticks — a Risks-style paragraph inside Forbidden paths was once read as forbidden globs and
#    reported DIRTY on the very files the contract allowed. Moving the paragraph made the identical
#    tree CLEAN, so the check was punishing the author for explaining themselves.
#
# 2. Take the FIRST backticked token of each bullet, not every one. Contracts label their entries
#    ("New: `a/b.swift`", "Modified: `c.ts`"), so stripping only the bullet marker leaves the label
#    glued to the path and every such entry reads as "outside Allowed paths". And a bullet's trailing
#    explanation legitimately names symbols in backticks — "- `src/a.ts` — replaces `oldThing()` with
#    `newThing()`" declares ONE file, not three. Counting all of them turned a 3-file contract into a
#    22-file one. One bullet, one declaration.
#
# A false positive here is worse than no check at all: it trains the next reader to skim past the
# line that is supposed to stop them.

contract_section() {
  local file="$1" name="$2"
  sed -n "/^## *$name/,/^## /p" "$file" \
    | grep -E '^ *[-*] ' \
    | sed -n 's/^[^`]*`\([^`]*\)`.*/\1/p' \
    | sed 's/ *#.*//' | sed '/^$/d'
}
