# Demo task: add a slugify utility

Implement `slugify(input: string): string` in `src/slugify.ts`.

Requirements:
- Trim whitespace, lowercase ASCII letters, turn runs of spaces and punctuation into one hyphen, and remove leading or trailing hyphens.
- Preserve an empty result for input containing no ASCII letters or digits.
- Add Vitest tests for mixed case, repeated separators, edge separators, and empty input.
- Keep changes inside `src/` and tests. Run the repository gate before opening a PR.
- Open a PR against `main`; do not merge it.
