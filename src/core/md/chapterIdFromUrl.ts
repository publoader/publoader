/**
 * Recover a publisher-side chapter id from the `externalUrl` MangaDex holds.
 *
 * WHY THIS EXISTS. `uploaded_chapters` is a log of what this platform uploaded,
 * so on a deployment whose upload history is younger than the catalogue most of
 * MangaDex's chapters have no row and no `chapter_id`. The adoption pass in
 * chapterReconcile.ts seeds those rows back from the MangaDex record, and the
 * MangaDex record carries the publisher's URL but never the publisher's id.
 *
 * The id matters beyond display: `uploaded_ids` is what routes/worker.ts hands
 * an extension as `postedChapterIds`, and extensions use it to decide they have
 * nothing to fetch. An id we cannot recover is work the extension redoes on
 * every run, forever.
 *
 * WHY IT IS LEARNED RATHER THAN WRITTEN DOWN. Nothing in a manifest describes
 * how an extension's ids sit inside its URLs, and hard-coding one rule per
 * extension would rot the moment a publisher changes its URL shape. But the
 * rows we DO have are worked examples of exactly that relationship: mangaplus
 * has 491 (chapterId, chapterUrl) pairs on the live deployment, every one of
 * them saying "the id is the last path segment". So the rule is measured off
 * the extension's own history and applied to the chapters missing from it.
 *
 * It fails closed. Fewer than `MIN_SAMPLES` examples, examples that disagree
 * about where the id sits, or ids that are not in the URL at all, and there is
 * no rule; the adoption pass then writes the row with a NULL `chapter_id`
 * rather than a guessed one. A wrong id in `uploaded_ids` would tell an
 * extension a chapter is posted when it is not, which is a silently missed
 * upload, so "no answer" has to be cheaper than "an answer that might be wrong".
 */

/** How an extension's chapter ids sit inside its chapter URLs. */
export interface ChapterIdUrlRule {
  /** The id is the last N path segments of the URL, joined by "/". */
  segments: number;
  /** Pairs the rule was measured from. */
  samples: number;
  /** Of those, the share that agree with it. 1 means unanimous. */
  agreement: number;
}

export interface ChapterIdSample {
  chapterId: string;
  chapterUrl: string;
}

/**
 * Pairs needed before any rule is believed.
 *
 * Low enough that a young extension is not locked out, high enough that a
 * coincidence does not become a rule: a single pair whose id happens to be its
 * last path segment proves nothing about the next chapter.
 */
export const MIN_SAMPLES = 5;

/**
 * Share of pairs that must agree.
 *
 * Not 1. A catalogue that has been running for years carries a handful of rows
 * whose URL was hand-corrected, or written before the publisher changed shape,
 * and demanding unanimity lets one of those veto a rule that holds for the
 * other few thousand. Not far below 1 either: at this threshold a disagreeing
 * minority is an anomaly, and anything larger is two rules fighting, which is
 * the case where guessing is genuinely unsafe.
 */
export const MIN_AGREEMENT = 0.95;

/** The path segments of a URL, empty ones dropped. Null when it is not a URL. */
function pathSegments(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.pathname.split("/").filter((segment) => segment !== "");
}

/**
 * How many trailing path segments of `chapterUrl` spell `chapterId`, or null
 * when none do.
 *
 * At most one answer is possible: the candidates are nested strings of
 * different lengths, so two of them cannot both equal the id.
 */
function segmentsSpanning(sample: ChapterIdSample): number | null {
  const segments = pathSegments(sample.chapterUrl);
  if (segments === null) return null;
  for (let take = 1; take <= segments.length; take += 1) {
    if (segments.slice(-take).join("/") === sample.chapterId) return take;
  }
  return null;
}

/**
 * Measure the rule an extension's own chapters demonstrate, or null when they
 * do not agree on one.
 */
export function learnChapterIdRule(samples: readonly ChapterIdSample[]): ChapterIdUrlRule | null {
  if (samples.length < MIN_SAMPLES) return null;

  const votes = new Map<number, number>();
  for (const sample of samples) {
    const take = segmentsSpanning(sample);
    // A pair whose id is nowhere in its URL is evidence against every rule, not
    // a pair to ignore: it is exactly the case where the URL does not carry the
    // id, and counting it out would hide that.
    if (take === null) continue;
    votes.set(take, (votes.get(take) ?? 0) + 1);
  }

  let best: { segments: number; count: number } | null = null;
  for (const [segments, count] of votes) {
    if (best === null || count > best.count) best = { segments, count };
  }
  if (best === null) return null;

  const agreement = best.count / samples.length;
  if (best.count < MIN_SAMPLES || agreement < MIN_AGREEMENT) return null;
  return { segments: best.segments, samples: samples.length, agreement };
}

/** Apply a measured rule to a URL. Null when the URL cannot satisfy it. */
export function chapterIdFromUrl(url: string, rule: ChapterIdUrlRule): string | null {
  const segments = pathSegments(url);
  if (segments === null || segments.length < rule.segments) return null;
  const id = segments.slice(-rule.segments).join("/");
  return id === "" ? null : id;
}
