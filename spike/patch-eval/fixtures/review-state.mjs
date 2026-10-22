// Review decisions belong to an exact pair of documents. History may restore a
// known pair; ordinary edits start a new review so stale approvals cannot survive.
export function createReviewState({ sameDocument = (a, b) => a === b, limit = 80 } = {}) {
  let current = null, kept = new Set(), applied = 0, snapshots = [], notice = '';
  const samePair = (left, right) => left && right && sameDocument(left.a, right.a) && sameDocument(left.b, right.b);
  function remember() {
    if (!current) return;
    const entry = { ...current, kept: new Set(kept), applied };
    const index = snapshots.findIndex(snapshot => samePair(snapshot, current));
    if (index >= 0) snapshots.splice(index, 1);
    snapshots.push(entry);
    if (snapshots.length > limit) snapshots.shift();
  }
  function cleanKeys() { kept = new Set([...kept].filter(key => current.keys.includes(key))); }
  function reset(pair = null, message = '') {
    current = pair; kept = new Set(); applied = 0; snapshots = []; notice = message;
    remember();
  }
  return {
    reset,
    invalidate() {
      const hadProgress = applied + kept.size > 0;
      reset(null, hadProgress ? 'Code edited — review restarted' : notice);
    },
    sync(pair, cause = 'edit') {
      if (!current) { reset(pair, notice); return; }
      if (samePair(current, pair)) { current = pair; cleanKeys(); return; }
      if (cause === 'history') {
        const found = snapshots.findLast(snapshot => samePair(snapshot, pair));
        if (found) {
          current = pair; kept = new Set(found.kept); applied = found.applied; notice = '';
          cleanKeys(); return;
        }
      }
      const hadProgress = applied + kept.size > 0;
      reset(pair, hadProgress ? 'Code edited — review restarted' : '');
    },
    keep(key) {
      if (!current?.keys.includes(key)) return false;
      kept.add(key); notice = ''; remember(); return true;
    },
    apply(key, nextPair) {
      if (!current?.keys.includes(key) || samePair(current, nextPair)) return false;
      remember();
      kept.delete(key); applied++;
      current = nextPair; cleanKeys(); notice = ''; remember(); return true;
    },
    isKept(key) { return kept.has(key); },
    get progress() {
      return { reviewed: applied + kept.size, total: applied + (current?.keys.length ?? 0), applied, kept: kept.size, notice };
    }
  };
}
