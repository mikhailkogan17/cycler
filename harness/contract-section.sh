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
# slash, plus, and/or. Articles, possessives and filesystem-role labels are allowed.
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
      function list_connector(text, has_separator) {
        text = tolower(text)
        gsub(/\((new|modified|existing|deleted)\)/, "", text)
        gsub(/[[:space:]]+/, " ", text)
        sub(/^ /, "", text); sub(/ $/, "", text)
        has_separator = 0
        if (text ~ /^[,;+\/]/) { sub(/^[,;+\/] */, "", text); has_separator = 1 }
        if (text ~ /^(and|or)( |$)/) { sub(/^(and|or) */, "", text); has_separator = 1 }
        if (!has_separator) return 0
        sub(/^(a|an|the|its|their|our)( |$)/, "", text)
        if (text ~ /^(new|modified|existing|deleted)?$/) return 1
        # A label describes a filesystem role, not what code does. Verbs and explanatory
        # phrases deliberately do not match, even if followed by a backticked path.
        return text ~ /^((new|modified|existing|deleted|matching|corresponding|associated|related|unit|integration|regression|test|source|config|configuration|build|runtime|supporting) )*(files?|tests?|companions?|fixtures?|scripts?|modules?|configs?|configurations?|assets?|headers?|implementations?)$/
      }
      {
        rest = $0; first = 1
        while (match(rest, /`[^`]+`/)) {
          connector = substr(rest, 1, RSTART - 1)
          if (!first && !list_connector(connector)) break
          print substr(rest, RSTART + 1, RLENGTH - 2)
          rest = substr(rest, RSTART + RLENGTH); first = 0
        }
      }' \
    | sed 's/ *#.*//' | sed '/^$/d'
}
