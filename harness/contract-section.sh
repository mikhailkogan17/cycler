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
# 2. Read a declaration and a contiguous path list separated by comma, semicolon,
# slash, plus, and/or. Articles and new/modified/existing/deleted labels are allowed.
# Stop at
# explanatory prose, so "`src/a.ts` — replaces `oldThing()`" declares only a.ts.
# Labels before the first token are supported; prose references are never declarations.
#
# A false positive here is worse than no check at all: it trains the next reader to skim past the
# line that is supposed to stop them.

contract_section() {
  local file="$1" name="$2"
  sed -n "/^## *$name/,/^## /p" "$file" \
    | grep -E '^ *[-*] ' \
    | awk '
      {
        rest = $0; first = 1
        while (match(rest, /`[^`]+`/)) {
          connector = substr(rest, 1, RSTART - 1)
          gsub(/[[:space:]]/, "", connector)
          connector = tolower(connector)
          gsub(/\((new|modified|existing|deleted)\)/, "", connector)
          if (!first && connector !~ /^([,;+\/]|and|or)(and|or)?(a|an|the)?(new|modified|existing|deleted)?$/) break
          print substr(rest, RSTART + 1, RLENGTH - 2)
          rest = substr(rest, RSTART + RLENGTH); first = 0
        }
      }' \
    | sed 's/ *#.*//' | sed '/^$/d'
}
