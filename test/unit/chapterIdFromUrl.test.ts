import { describe, expect, it } from "vitest";
import {
  chapterIdFromUrl,
  learnChapterIdRule,
  MIN_SAMPLES,
} from "../../src/core/md/chapterIdFromUrl.js";

/**
 * Recovering a publisher chapter id from the URL MangaDex holds.
 *
 * The stakes are asymmetric and that is what these tests are about. A recovered
 * id lands in `uploaded_ids`, which reaches the extension as `postedChapterIds`
 * and is how it decides a chapter needs no fetching. Failing to recover one
 * costs a repeated detail call; recovering the WRONG one tells the extension a
 * chapter is posted when it is not, which is an upload silently never made. So
 * every "no answer" case below is a deliberate refusal, not a gap.
 */
describe("learning an extension's URL-to-chapter-id rule", () => {
  const mangaplus = (id: string) => ({
    chapterId: id,
    chapterUrl: `https://mangaplus.shueisha.co.jp/viewer/${id}`,
  });

  it("reads the rule off the extension's own rows", () => {
    const rule = learnChapterIdRule([
      mangaplus("1029798"),
      mangaplus("1029799"),
      mangaplus("700"),
      mangaplus("1012345"),
      mangaplus("1014090"),
    ]);

    expect(rule).toEqual({ segments: 1, samples: 5, agreement: 1 });
    expect(chapterIdFromUrl("https://mangaplus.shueisha.co.jp/viewer/555", rule!)).toBe("555");
  });

  it("learns a multi-segment id where the extension has one", () => {
    // viz serves two catalogues from one extension, and the catalogue name is
    // part of the id: dropping it would collapse two different series' chapters
    // onto one id.
    const samples = ["1", "2", "3", "4", "5", "6"].map((n) => ({
      chapterId: `shonenjump/${n}`,
      chapterUrl: `https://viz.example/read/shonenjump/${n}`,
    }));

    const rule = learnChapterIdRule(samples);

    expect(rule?.segments).toBe(2);
    expect(chapterIdFromUrl("https://viz.example/read/shonenjump/9", rule!)).toBe("shonenjump/9");
  });

  it("refuses when the extension has too little history to be sure", () => {
    const samples = Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => mangaplus(String(i)));
    expect(learnChapterIdRule(samples)).toBeNull();
  });

  it("refuses when the id is not in the URL at all", () => {
    // An extension whose ids are opaque to its URLs: there is nothing to read,
    // and a last-path-segment guess would produce plausible-looking rubbish.
    const samples = Array.from({ length: 20 }, (_, i) => ({
      chapterId: `opaque-${i}`,
      chapterUrl: `https://pub.example/read?chapter=${i}`,
    }));
    expect(learnChapterIdRule(samples)).toBeNull();
  });

  it("refuses when the extension's rows disagree about where the id sits", () => {
    // Half say "last segment", half say "last two". Neither is the rule, and
    // adopting the more popular one would mis-parse every chapter of the other
    // half. Two shapes fighting is exactly the case where guessing is unsafe.
    const flat = Array.from({ length: 10 }, (_, i) => ({
      chapterId: String(i),
      chapterUrl: `https://pub.example/read/${i}`,
    }));
    const nested = Array.from({ length: 10 }, (_, i) => ({
      chapterId: `series/${i}`,
      chapterUrl: `https://pub.example/read/series/${i}`,
    }));

    expect(learnChapterIdRule([...flat, ...nested])).toBeNull();
  });

  it("survives a handful of odd rows without letting them veto the rule", () => {
    // A catalogue running for years carries rows whose URL was hand-corrected.
    // Demanding unanimity would let one of those cost the extension the
    // postedChapterIds skip on several thousand chapters.
    const good = Array.from({ length: 99 }, (_, i) => mangaplus(String(i)));
    const odd = { chapterId: "1234", chapterUrl: "https://mangaplus.shueisha.co.jp/" };

    const rule = learnChapterIdRule([...good, odd]);

    expect(rule?.segments).toBe(1);
    expect(rule?.agreement).toBeCloseTo(0.99, 5);
  });

  it("refuses once the disagreement is more than an anomaly", () => {
    const good = Array.from({ length: 10 }, (_, i) => mangaplus(String(i)));
    const bad = Array.from({ length: 3 }, (_, i) => ({
      chapterId: `x${i}`,
      chapterUrl: "https://mangaplus.shueisha.co.jp/",
    }));

    expect(learnChapterIdRule([...good, ...bad])).toBeNull();
  });

  it("gives no answer for a URL that cannot satisfy the rule", () => {
    const rule = { segments: 2, samples: 50, agreement: 1 };

    // Too few segments to spell a two-segment id, and not a URL at all.
    expect(chapterIdFromUrl("https://pub.example/only-one", rule)).toBeNull();
    expect(chapterIdFromUrl("https://pub.example/", rule)).toBeNull();
    expect(chapterIdFromUrl("not a url", rule)).toBeNull();
  });

  it("ignores a trailing slash rather than reading an empty id from it", () => {
    const rule = learnChapterIdRule(
      Array.from({ length: 10 }, (_, i) => mangaplus(String(i))),
    );
    expect(chapterIdFromUrl("https://mangaplus.shueisha.co.jp/viewer/42/", rule!)).toBe("42");
  });

  it("reads the id from the path and never from the query or fragment", () => {
    const rule = learnChapterIdRule(
      Array.from({ length: 10 }, (_, i) => mangaplus(String(i))),
    );
    expect(chapterIdFromUrl("https://mangaplus.shueisha.co.jp/viewer/42?lang=en", rule!)).toBe("42");
    expect(chapterIdFromUrl("https://mangaplus.shueisha.co.jp/viewer/42#page3", rule!)).toBe("42");
  });
});
