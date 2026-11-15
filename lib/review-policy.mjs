export function admitReview({ history = [], round, head, previousReview }) {
  if (history.length >= 3) throw new Error('Review repeat budget exhausted: one Sol initial and two Luna repeats');
  if (history.length !== round - 1) throw new Error(`Review round mismatch: expected ${history.length + 1}`);
  if (history.length) {
    const previous = history.at(-1);
    if (head === previous.head) throw new Error('Review repeat requires a new pushed PR head');
    if (!previousReview || previousReview.head !== previous.head || !Array.isArray(previousReview.confirmed))
      throw new Error('Review repeat missing prior findings');
  }
  return { model: history.length ? 'gpt-6-luna' : 'gpt-6.1-sol', repeat: history.length > 0 };
}
export function completeReview(history, result, model) {
  if (!result || result.published !== true || !result.head || !Array.isArray(result.confirmed))
    throw new Error('Review returned missing output');
  return [...history, { head: result.head, model, findings: result.confirmed, threads: result.threads || [], at: Date.now() }];
}
