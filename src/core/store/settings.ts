import type { Prisma, PrismaClient, ScheduleEntry, UploadTaskKind } from "@prisma/client";
import type { ScheduleSlot } from "../../contracts/manifest.js";

/** A stored slot: the contract shape plus the two things only a row has. */
export interface StoredScheduleSlot extends ScheduleSlot {
  id: string;
  enabled: boolean;
}

/** Chronological, so every listing reads like a day's timetable. */
const scheduleOrder: Prisma.ScheduleEntryOrderByWithRelationInput[] = [
  { hour: "asc" },
  { minute: "asc" },
  { kind: "asc" },
];

function rowToSlot(row: ScheduleEntry): ScheduleSlot {
  return {
    hour: row.hour,
    minute: row.minute,
    days: [...row.days].sort((a, b) => a - b),
    kind: row.kind,
    ...(row.label !== null ? { label: row.label } : {}),
  };
}

function slotToRow(slot: ScheduleSlot) {
  return {
    hour: slot.hour,
    minute: slot.minute,
    days: slot.days,
    kind: slot.kind,
    label: slot.label ?? null,
  };
}

function sameDays(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
}

const PAUSE_KEY = "pause_until";
const REMOVAL_MODE_KEY = "chapter_removal_mode";
const SIGNUPS_KEY = "dash_signups_enabled";
const WEBHOOK_SUCCESSES_KEY = "webhook_upload_successes";
const GITHUB_AUTO_SYNC_KEY = "github_auto_sync";
const UPLOAD_SCHEDULE_KEY = "upload_schedule";
const UPLOAD_SCHEDULE_OVERRIDES_KEY = "upload_schedule_overrides";
const UPLOAD_SCHEDULE_KINDS_KEY = "upload_schedule_kinds";
const UPLOAD_BUDGET_SCOPE_KEY = "upload_budget_scope";
const UPLOAD_PRIORITY_KEY = "upload_priority_extensions";
const UPLOAD_PAUSED_KEY = "upload_paused_extensions";

const FETCH_THROTTLE_KEY = "fetch_throttle";
const FETCH_THROTTLE_OVERRIDES_KEY = "fetch_throttle_overrides";

/**
 * How many chapters a run may put on MangaDex *today*, and how the rest are
 * dated.
 *
 * This is spread, not suppression: every decided chapter is queued in the same
 * pass either way, and `perDay` only decides which of them are due now and
 * which carry a future `not_before`. A future-dated task is an ordinary PENDING
 * row the claim query ignores until its date arrives, so nothing is dropped,
 * retried, or recomputed to make it happen.
 *
 * The reason to want it: a routine day is a couple of dozen chapters and lands
 * immediately, but tracking a batch of new series, or the first run after an
 * outage, decides hundreds at once. Those flood MangaDex's latest-updates feed
 * and sit in front of every ordinary update in the upload queue.
 */
export interface UploadSchedule {
  /** Chapters dated to a given day, across every series. 0 disables spreading. */
  perDay: number;
  /**
   * Chapters dated to a given day for one series.
   *
   * Separate from `perDay` because the two failure modes differ: `perDay`
   * protects the feed and the queue, `perMangaPerDay` stops one series' backlog
   * from being the only thing anyone sees for a week.
   */
  perMangaPerDay: number;
  /** Gap between successive release days. */
  intervalHours: number;
  /**
   * Minimum gap between two consecutive uploads, in seconds.
   *
   * Seconds rather than minutes because a minute is the *slowest* rate anybody
   * has wanted: "two a minute" is an ordinary request and a whole-minute field
   * cannot express it at all.
   *
   * This is the queue's pace, not a property of one run, so it applies in both
   * places work becomes claimable:
   *
   *  - when a spread run plans a day, it spaces that day's allowance rather
   *    than giving every chapter in it the same instant;
   *  - when anything is enqueued — a routine update, a hand-added task — the
   *    new row is dated behind the queue's tail instead of on top of it.
   *
   * Without the second half the setting only ever reached work that a backlog
   * planned, and the ordinary case (a run queues twelve chapters, all due now)
   * still went out back to back.
   *
   * `0` means auto: a spread day divides its allowance across the interval, and
   * enqueueing does not pace at all. A number forces at least that gap
   * everywhere.
   */
  spacingSeconds: number;
}

export const DEFAULT_UPLOAD_SCHEDULE: UploadSchedule = {
  perDay: 50,
  perMangaPerDay: 3,
  intervalHours: 24,
  spacingSeconds: 0,
};

/**
 * Whose budget `perDay` is.
 *
 * `global` is one pool for the whole platform: five extensions share 50/day,
 * which is what protects MangaDex's feed, since the feed does not care which
 * extension a chapter came from. `extension` gives each extension its own
 * allowance, which is what you want when one publisher's backlog should not
 * hold up another's routine updates.
 */
export type UploadBudgetScope = "global" | "extension";
export const UPLOAD_BUDGET_SCOPES = ["global", "extension"] as const;
export const DEFAULT_UPLOAD_BUDGET_SCOPE: UploadBudgetScope = "global";

/**
 * Extensions whose routine updates go out NOW, whatever else is waiting.
 *
 * `enqueue` normally dates a paced task at `max(not_before) + spacing` over
 * every pending upload, so one publisher's backlog pushes everybody else behind
 * it: a comikey clean run dated into next week moves tomorrow's MANGA Plus
 * chapters to next week too, because they chain onto the same tail. For a daily
 * publisher that is the wrong answer -- its updates are worth little late, and
 * they are a handful of chapters, not a flood.
 *
 * A listed extension ignores that tail entirely. Its chapters are queued due
 * immediately, however long the queue is and whether or not the day's budget
 * has already been spent, which is what puts them in front of a backlog dated
 * days out. The uploader still drains serially at its own MangaDex rate limit,
 * so "due now" means "first in line", not "all at once".
 *
 * Deliberately NOT applied to clean runs. A clean run IS the backlog -- the
 * comikey import that started this was 2,000 chapters -- and spreading it over
 * days is the entire point of the schedule. Letting it claim priority would
 * turn one catalogue import into a flood of MangaDex's feed and put it in front
 * of every other extension's routine updates, which is the problem this exists
 * to fix rather than a new way to cause it.
 */
export const DEFAULT_UPLOAD_PRIORITY_EXTENSIONS: string[] = [];

/**
 * Extensions whose queued work is held, without being cancelled.
 *
 * The global pause stops the whole platform, which is the wrong instrument when
 * one publisher is the problem: a comikey backlog that needs looking at should
 * not also stop MANGA Plus publishing today's chapters. This holds one
 * extension's tasks and leaves everybody else draining.
 *
 * It is a claim-time filter, not a state change. Tasks stay PENDING with their
 * dates untouched, so nothing is cancelled, re-queued or re-dated, and removing
 * the name resumes exactly where the queue was. That also means a paused
 * extension keeps ACCUMULATING work -- runs still decide and enqueue normally;
 * only the uploader declines to pick it up. Pausing to stop a runaway backlog
 * growing is the one thing this does not do.
 */
export const DEFAULT_UPLOAD_PAUSED_EXTENSIONS: string[] = [];

/**
 * Bounds, not preferences. `perDay: 0` is meaningful (spread nothing, the
 * behaviour before this existed) so the floor is 0, not 1.
 */
function clampUploadSchedule(value: UploadSchedule): UploadSchedule {
  const num = (raw: number, fallback: number, min: number, max: number): number =>
    Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.floor(raw))) : fallback;
  return {
    perDay: num(value.perDay, DEFAULT_UPLOAD_SCHEDULE.perDay, 0, 100_000),
    perMangaPerDay: num(value.perMangaPerDay, DEFAULT_UPLOAD_SCHEDULE.perMangaPerDay, 0, 100_000),
    intervalHours: num(value.intervalHours, DEFAULT_UPLOAD_SCHEDULE.intervalHours, 1, 24 * 30),
    // Capped at a day: a gap longer than that is a pause, not a pace, and the
    // per-day cap is the tool for holding work back.
    spacingSeconds: num(value.spacingSeconds, DEFAULT_UPLOAD_SCHEDULE.spacingSeconds, 0, 24 * 3600),
  };
}

/** Reads whatever was stored without trusting any of it. */
function parseUploadSchedule(raw: unknown): Partial<UploadSchedule> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: Partial<UploadSchedule> = {};
  for (const key of ["perDay", "perMangaPerDay", "intervalHours", "spacingSeconds"] as const) {
    const field = record[key];
    if (typeof field === "number") out[key] = field;
  }
  return out;
}

/** How a worker paces itself against one publisher. */
export interface FetchThrottle {
  /** Minimum gap between two requests to the same host. */
  minIntervalMs: number;
  /** Off restores an exact interval, which is itself a recognisable pattern. */
  jitter: boolean;
  /** Random extra as a fraction of the gap: 0.5 turns 500ms into 500-750ms. */
  jitterRatio: number;
}

export const DEFAULT_FETCH_THROTTLE: FetchThrottle = {
  minIntervalMs: 500,
  jitter: true,
  jitterRatio: 0.5,
};

/**
 * Bounds, not preferences.
 *
 * This throttle is the only thing pacing our requests at a publisher, so a
 * stray 0 in a settings field must not be able to turn it into a flood. The
 * ceiling is just as deliberate: an interval of an hour would stall every run
 * without ever looking like a failure.
 */
function clampThrottle(value: FetchThrottle): FetchThrottle {
  const num = (raw: number, fallback: number, min: number, max: number): number =>
    Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
  return {
    minIntervalMs: num(value.minIntervalMs, DEFAULT_FETCH_THROTTLE.minIntervalMs, 100, 60_000),
    jitter: value.jitter !== false,
    jitterRatio: num(value.jitterRatio, DEFAULT_FETCH_THROTTLE.jitterRatio, 0, 5),
  };
}

/** Reads whatever was stored without trusting any of it. */
function parseThrottle(raw: unknown): Partial<FetchThrottle> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const out: Partial<FetchThrottle> = {};
  if (typeof record["minIntervalMs"] === "number") out.minIntervalMs = record["minIntervalMs"];
  if (typeof record["jitter"] === "boolean") out.jitter = record["jitter"];
  if (typeof record["jitterRatio"] === "number") out.jitterRatio = record["jitterRatio"];
  return out;
}

function parseRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
export const VALID_REMOVAL_MODES = ["unavailable", "delete"] as const;
export type RemovalMode = (typeof VALID_REMOVAL_MODES)[number];
export const DEFAULT_REMOVAL_MODE: RemovalMode = "unavailable";

/** Pause gate, schedule overrides, disabled extensions, removal mode;
 * replaces the SQLite state store with the same semantics. */
export class SettingsStore {
  constructor(private readonly prisma: PrismaClient) {}

  async setSetting(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async clearSetting(key: string): Promise<void> {
    await this.prisma.setting.deleteMany({ where: { key } });
  }

  // -- pause gate (Infinity = paused until explicit resume) --

  async setPauseUntil(epochSeconds: number): Promise<void> {
    if (epochSeconds <= 0) return this.clearSetting(PAUSE_KEY);
    await this.setSetting(PAUSE_KEY, epochSeconds === Infinity ? "inf" : String(epochSeconds));
  }

  async getPauseUntil(): Promise<number> {
    const raw = await this.getSetting(PAUSE_KEY);
    if (!raw) return 0;
    if (raw === "inf") return Infinity;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async isPaused(): Promise<boolean> {
    return Date.now() / 1000 < (await this.getPauseUntil());
  }

  // -- removal mode --

  async getRemovalMode(): Promise<RemovalMode> {
    const value = await this.getSetting(REMOVAL_MODE_KEY);
    return (VALID_REMOVAL_MODES as readonly string[]).includes(value ?? "")
      ? (value as RemovalMode)
      : DEFAULT_REMOVAL_MODE;
  }

  async setRemovalMode(mode: RemovalMode): Promise<void> {
    await this.setSetting(REMOVAL_MODE_KEY, mode);
  }

  // -- publisher fetch pacing --

  /**
   * How fast a worker may talk to one publisher, and how regular it looks.
   *
   * Operator infrastructure rather than extension config, so it lives here and
   * not in an extension's own settings document: the operator owns how hard
   * their addresses hit a publisher, and the answer differs per publisher
   * without the extension having any say in it.
   *
   * Resolved global-then-override, field by field, so an extension can raise
   * its interval without restating the jitter it was already happy with.
   */
  async getFetchThrottle(extension?: string): Promise<FetchThrottle> {
    const [globalRaw, overridesRaw] = await Promise.all([
      this.getSetting(FETCH_THROTTLE_KEY),
      extension ? this.getSetting(FETCH_THROTTLE_OVERRIDES_KEY) : Promise.resolve(null),
    ]);
    const base = { ...DEFAULT_FETCH_THROTTLE, ...parseThrottle(globalRaw) };
    if (!extension) return clampThrottle(base);
    const overrides = parseRecord(overridesRaw);
    return clampThrottle({ ...base, ...parseThrottle(overrides[extension]) });
  }

  async setFetchThrottle(values: Partial<FetchThrottle>): Promise<void> {
    const next = clampThrottle({ ...(await this.getFetchThrottle()), ...values });
    await this.setSetting(FETCH_THROTTLE_KEY, JSON.stringify(next));
  }

  /** Every per-extension override, for the editor to render. */
  async getFetchThrottleOverrides(): Promise<Record<string, Partial<FetchThrottle>>> {
    const parsed = parseRecord(await this.getSetting(FETCH_THROTTLE_OVERRIDES_KEY));
    const out: Record<string, Partial<FetchThrottle>> = {};
    for (const [name, value] of Object.entries(parsed)) out[name] = parseThrottle(value);
    return out;
  }

  /** `null` removes the override, so the extension follows the global again. */
  async setFetchThrottleOverride(
    extension: string,
    values: Partial<FetchThrottle> | null,
  ): Promise<void> {
    const overrides = await this.getFetchThrottleOverrides();
    if (values === null) delete overrides[extension];
    else overrides[extension] = values;
    await this.setSetting(FETCH_THROTTLE_OVERRIDES_KEY, JSON.stringify(overrides));
  }

  // -- upload release spreading --

  /**
   * Resolved global-then-override, field by field, exactly like the fetch
   * throttle: an extension can slow its own releases without restating the
   * limits it was already happy with.
   */
  /**
   * The schedule for one queue, optionally narrowed to one extension.
   *
   * `kind` is what stops the five queues sharing an allowance. They reach
   * MangaDex through different endpoints with different costs -- an UPLOAD
   * opens a session and pushes images, an UNAVAILABLE is one PUT -- so pacing
   * them from one number means the cheap queues either crawl at the expensive
   * one's rate or drag it up to theirs. Each kind resolves its own settings and
   * (in `UploadTaskStore`) counts only its own rows, so a 2,000-chapter upload
   * backlog cannot hold up a handful of edits behind it.
   *
   * Layered narrowest-wins: defaults, the global, that kind, then the
   * extension. Kind sits under extension deliberately -- an operator pinning
   * one publisher's pace means it for that publisher's work, whichever queue it
   * lands in -- and unset kinds simply follow the global, so nothing changes
   * for anyone who never opens the per-queue controls.
   */
  async getUploadSchedule(extension?: string, kind?: UploadTaskKind): Promise<UploadSchedule> {
    const [globalRaw, kindsRaw, overridesRaw] = await Promise.all([
      this.getSetting(UPLOAD_SCHEDULE_KEY),
      kind ? this.getSetting(UPLOAD_SCHEDULE_KINDS_KEY) : Promise.resolve(null),
      extension ? this.getSetting(UPLOAD_SCHEDULE_OVERRIDES_KEY) : Promise.resolve(null),
    ]);
    let base = { ...DEFAULT_UPLOAD_SCHEDULE, ...parseUploadSchedule(globalRaw) };
    if (kind) base = { ...base, ...parseUploadSchedule(parseRecord(kindsRaw)[kind]) };
    if (!extension) return clampUploadSchedule(base);
    const overrides = parseRecord(overridesRaw);
    return clampUploadSchedule({ ...base, ...parseUploadSchedule(overrides[extension]) });
  }

  /** Every per-queue override, for the editor to render. */
  async getUploadScheduleKinds(): Promise<Record<string, Partial<UploadSchedule>>> {
    const parsed = parseRecord(await this.getSetting(UPLOAD_SCHEDULE_KINDS_KEY));
    const out: Record<string, Partial<UploadSchedule>> = {};
    for (const [name, value] of Object.entries(parsed)) out[name] = parseUploadSchedule(value);
    return out;
  }

  /** `null` removes the override, so that queue follows the global again. */
  async setUploadScheduleKind(
    kind: UploadTaskKind,
    values: Partial<UploadSchedule> | null,
  ): Promise<void> {
    const kinds = await this.getUploadScheduleKinds();
    if (values === null) delete kinds[kind];
    else kinds[kind] = values;
    await this.setSetting(UPLOAD_SCHEDULE_KINDS_KEY, JSON.stringify(kinds));
  }

  async setUploadSchedule(values: Partial<UploadSchedule>): Promise<void> {
    const next = clampUploadSchedule({ ...(await this.getUploadSchedule()), ...values });
    await this.setSetting(UPLOAD_SCHEDULE_KEY, JSON.stringify(next));
  }

  /**
   * Whether `perDay` is one platform-wide pool or one pool per extension.
   *
   * Read as a whole-platform policy rather than a field on `UploadSchedule`,
   * because a per-extension override choosing its own scope is incoherent: the
   * question "is this budget shared?" has one answer for everybody.
   */
  async getUploadBudgetScope(): Promise<UploadBudgetScope> {
    const raw = await this.getSetting(UPLOAD_BUDGET_SCOPE_KEY);
    return raw === "extension" ? "extension" : DEFAULT_UPLOAD_BUDGET_SCOPE;
  }

  async setUploadBudgetScope(scope: UploadBudgetScope): Promise<void> {
    await this.setSetting(UPLOAD_BUDGET_SCOPE_KEY, scope);
  }

  /**
   * Extensions that pace behind their own queue instead of the platform's.
   *
   * Unknown or malformed content reads as "nobody has priority", which is the
   * behaviour this setting was added on top of: a bad value must not silently
   * promote an extension past everything else.
   */
  async getUploadPriorityExtensions(): Promise<string[]> {
    const raw = await this.getSetting(UPLOAD_PRIORITY_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.filter((v): v is string => typeof v === "string" && v !== ""))].sort();
    } catch {
      return [];
    }
  }

  async setUploadPriorityExtensions(names: string[]): Promise<string[]> {
    const clean = [...new Set(names.filter((n) => typeof n === "string" && n !== ""))].sort();
    await this.setSetting(UPLOAD_PRIORITY_KEY, JSON.stringify(clean));
    return clean;
  }

  /**
   * Extensions the uploader is currently declining to claim work for.
   *
   * Malformed content reads as "nothing is paused", the same direction the
   * priority list fails in: a bad value must not silently stop the queue.
   */
  async getUploadPausedExtensions(): Promise<string[]> {
    const raw = await this.getSetting(UPLOAD_PAUSED_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.filter((v): v is string => typeof v === "string" && v !== ""))].sort();
    } catch {
      return [];
    }
  }

  async setUploadPausedExtensions(names: string[]): Promise<string[]> {
    const clean = [...new Set(names.filter((n) => typeof n === "string" && n !== ""))].sort();
    await this.setSetting(UPLOAD_PAUSED_KEY, JSON.stringify(clean));
    return clean;
  }

  /** Every per-extension override, for the editor to render. */
  async getUploadScheduleOverrides(): Promise<Record<string, Partial<UploadSchedule>>> {
    const parsed = parseRecord(await this.getSetting(UPLOAD_SCHEDULE_OVERRIDES_KEY));
    const out: Record<string, Partial<UploadSchedule>> = {};
    for (const [name, value] of Object.entries(parsed)) out[name] = parseUploadSchedule(value);
    return out;
  }

  /** `null` removes the override, so the extension follows the global again. */
  async setUploadScheduleOverride(
    extension: string,
    values: Partial<UploadSchedule> | null,
  ): Promise<void> {
    const overrides = await this.getUploadScheduleOverrides();
    if (values === null) delete overrides[extension];
    else overrides[extension] = values;
    await this.setSetting(UPLOAD_SCHEDULE_OVERRIDES_KEY, JSON.stringify(overrides));
  }

  // -- dashboard self-signup gate --

  /**
   * Off unless explicitly turned on: with signups enabled, anyone who can
   * complete a Discord login creates an (unapproved) account row.
   */
  async getSignupsEnabled(): Promise<boolean> {
    return (await this.getSetting(SIGNUPS_KEY)) === "true";
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await this.setSetting(SIGNUPS_KEY, enabled ? "true" : "false");
  }

  // -- webhook verbosity --

  /**
   * Whether a per-chapter embed is sent for uploads that SUCCEEDED.
   *
   * Sending one either way means that on a normal run the channel is
   * almost entirely "Success: True"; and a failure, the only thing anyone
   * needs to act on, scrolls past between them. Off by default so the channel
   * carries exceptions rather than a transcript; the run-level "Found N
   * chapters" embed already says the work happened.
   *
   * Failures are NOT configurable: there is no reading of this system where
   * silently dropping a failed upload is what the operator wanted.
   */
  async getWebhookUploadSuccesses(): Promise<boolean> {
    return (await this.getSetting(WEBHOOK_SUCCESSES_KEY)) === "true";
  }

  async setWebhookUploadSuccesses(enabled: boolean): Promise<void> {
    await this.setSetting(WEBHOOK_SUCCESSES_KEY, enabled ? "true" : "false");
  }

  // -- github auto-sync --

  /**
   * Whether the scheduler polls the configured GitHub repos and publishes what
   * changed.
   *
   * On by default. The push webhook is the fast path, but it fails silently,
 * an unregistered hook or a dropped delivery just means extensions quietly
   * stop updating, and polling is the only check that does not depend on
   * anything inbound. Publishing is idempotent, so the two overlapping costs
   * nothing.
   *
   * Turn it off to freeze the fleet on the currently published bundles, which
   * is what you want while investigating a bad extension.
   */
  async getGithubAutoSync(): Promise<boolean> {
    return (await this.getSetting(GITHUB_AUTO_SYNC_KEY)) !== "false";
  }

  async setGithubAutoSync(enabled: boolean): Promise<void> {
    await this.setSetting(GITHUB_AUTO_SYNC_KEY, enabled ? "true" : "false");
  }

  // -- schedule entries --

  /**
   * Operator schedule slots, ready for `effectiveSchedules`.
   *
   * An extension appears as a key as soon as it has ANY row, even if every one
   * of them is switched off; the empty array then means "operator says run
   * nothing", which is a different answer from the absent key's "no operator
   * opinion, use the manifest".
   */
  async getScheduleOverrides(): Promise<Record<string, ScheduleSlot[]>> {
    const rows = await this.prisma.scheduleEntry.findMany({ orderBy: scheduleOrder });
    const out: Record<string, ScheduleSlot[]> = {};
    for (const row of rows) {
      const slots = (out[row.extension] ??= []);
      if (row.enabled) slots.push(rowToSlot(row));
    }
    return out;
  }

  /** Every row for one extension, disabled ones included, with their ids. */
  async listScheduleEntries(extension: string): Promise<StoredScheduleSlot[]> {
    const rows = await this.prisma.scheduleEntry.findMany({
      where: { extension },
      orderBy: scheduleOrder,
    });
    return rows.map((row) => ({ id: row.id, enabled: row.enabled, ...rowToSlot(row) }));
  }

  /** All rows, grouped, for the fleet-wide listing. */
  async listAllScheduleEntries(): Promise<Record<string, StoredScheduleSlot[]>> {
    const rows = await this.prisma.scheduleEntry.findMany({ orderBy: scheduleOrder });
    const out: Record<string, StoredScheduleSlot[]> = {};
    for (const row of rows) {
      (out[row.extension] ??= []).push({ id: row.id, enabled: row.enabled, ...rowToSlot(row) });
    }
    return out;
  }

  /**
   * Append one slot, seeding from the manifest first if this extension has no
   * rows yet.
   *
   * The seeding is what makes "add a Wednesday clean" safe. Operator rows
   * replace the manifest wholesale, so without it the first `add` would delete
   * the daily update the manifest declared: a surprise the operator would only
   * notice a day later, as an extension that stopped updating.
   *
   * Returns `created: false` when an identical slot (same minute, same kind,
   * same weekdays) is already there, so re-running the command is a no-op
   * rather than a way to schedule the same run twice.
   */
  async addScheduleEntry(
    extension: string,
    slot: ScheduleSlot,
    manifestSlots: ScheduleSlot[] = [],
  ): Promise<{ id: string; created: boolean; seeded: number }> {
    const existing = await this.prisma.scheduleEntry.findMany({ where: { extension } });
    let seeded = 0;
    if (existing.length === 0 && manifestSlots.length > 0) {
      await this.prisma.scheduleEntry.createMany({
        data: manifestSlots.map((s) => ({ extension, ...slotToRow(s) })),
      });
      seeded = manifestSlots.length;
    }
    const duplicate = (
      seeded > 0 ? await this.prisma.scheduleEntry.findMany({ where: { extension } }) : existing
    ).find(
      (row) =>
        row.hour === slot.hour &&
        row.minute === slot.minute &&
        row.kind === slot.kind &&
        sameDays(row.days, slot.days),
    );
    if (duplicate) return { id: duplicate.id, created: false, seeded };
    const row = await this.prisma.scheduleEntry.create({
      data: { extension, ...slotToRow(slot) },
    });
    return { id: row.id, created: true, seeded };
  }

  /**
   * Make this list of slots the whole schedule for the extension.
   *
   * One transaction: an operator who replaces a schedule must never be able to
   * observe, or have the scheduler observe, the window where the old slots
   * are gone and the new ones are not there yet.
   */
  async replaceScheduleEntries(extension: string, slots: ScheduleSlot[]): Promise<number> {
    await this.prisma.$transaction([
      this.prisma.scheduleEntry.deleteMany({ where: { extension } }),
      this.prisma.scheduleEntry.createMany({
        data: slots.map((s) => ({ extension, ...slotToRow(s) })),
      }),
    ]);
    return slots.length;
  }

  /** Drop one slot. Scoped by extension so an id from another one cannot hit. */
  async removeScheduleEntry(extension: string, id: string): Promise<boolean> {
    const res = await this.prisma.scheduleEntry.deleteMany({ where: { extension, id } });
    return res.count > 0;
  }

  /** Switch one slot on or off without losing what it said. */
  async setScheduleEntryEnabled(extension: string, id: string, enabled: boolean): Promise<boolean> {
    const res = await this.prisma.scheduleEntry.updateMany({
      where: { extension, id },
      data: { enabled },
    });
    return res.count > 0;
  }

  /** Drop every slot, falling the extension back to its manifest schedule. */
  async removeSchedule(extension: string): Promise<boolean> {
    const res = await this.prisma.scheduleEntry.deleteMany({ where: { extension } });
    return res.count > 0;
  }

  // -- disabled extensions --

  async listDisabled(): Promise<string[]> {
    const rows = await this.prisma.disabledExtension.findMany();
    return rows.map((r) => r.extension).sort();
  }

  async isDisabled(extension: string): Promise<boolean> {
    return (await this.prisma.disabledExtension.findUnique({ where: { extension } })) !== null;
  }

  async disable(extension: string): Promise<void> {
    await this.prisma.disabledExtension.upsert({
      where: { extension },
      create: { extension },
      update: {},
    });
  }

  async enable(extension: string): Promise<void> {
    await this.prisma.disabledExtension.deleteMany({ where: { extension } });
  }
}

export class AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async record(actor: string, action: string, subject?: string, detail?: unknown): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actor: actor.slice(0, 256),
        action: action.slice(0, 128),
        subject: subject?.slice(0, 512) ?? null,
        detail: detail === undefined ? undefined : (detail as object),
      },
    });
  }

  /**
   * Several events in one statement.
   *
   * For a bulk operator action the per-subject rows are what keep "why was this
   * chapter deleted?" answerable, a lookup by `subject` finds nothing if a
   * batch only writes one summary row, but two hundred sequential inserts
   * inside a request is a cost with no upside.
   */
  async recordMany(
    rows: readonly { actor: string; action: string; subject?: string; detail?: unknown }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.prisma.auditEvent.createMany({
      data: rows.map((row) => ({
        actor: row.actor.slice(0, 256),
        action: row.action.slice(0, 128),
        subject: row.subject?.slice(0, 512) ?? null,
        detail: row.detail === undefined ? undefined : (row.detail as object),
      })),
    });
  }

  async recent(limit = 100): Promise<unknown[]> {
    return this.prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  }
}
