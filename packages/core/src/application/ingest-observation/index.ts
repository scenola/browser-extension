/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The use case that turns a tab's observations into sittings and viewings. Where one sample
// goes is decided in route.ts; what the tab keeps between observations is tab.ts.

import { dueStart } from '../../domain/account-rule';
import type { PlaybackSample } from '../../domain/coverage';
import { electFrame } from '../../domain/frames';
import type { ElectedFrame, FrameReport } from '../../domain/frames';
import { ignoredOf } from '../../domain/ignored';
import type { IgnoredReason } from '../../domain/ignored';
import { titleKey, viewingKey } from '../../domain/reading';
import type { MergedReading, ViewingKey } from '../../domain/reading';
import { isPaused, reportAllowed } from '../../domain/settings';
import type { SettingsValue } from '../../domain/settings';
import type { EpochMs } from '../../domain/time';
import {
  applySample,
  contradictsShowYear,
  isAdTime,
  joinTarget,
  mediaLength,
  newViewing,
  reportVerdict,
  sameShowOnService,
  sameTitleRefinement,
  storySeconds,
} from '../../domain/viewing';
import type { Viewing } from '../../domain/viewing';
import type {
  AccountKey,
  AccountRules,
  Clock,
  Ids,
  Settings,
  SoundedPlayer,
  TabState,
  ViewingStore,
} from '../ports';
import type { ReportViewing } from '../report-viewing';
import type { LockHeld, ViewingLock } from '../viewing-lock';
import { NOTHING, routeOf } from './route';
import type { Route } from './route';
import {
  continuesSitting,
  emptyTab,
  fromOtherMedia,
  ignoring,
  lengthAfter,
  settle,
  sittingFrameOf,
  sittingHeldElsewhere,
  sittingLengthOf,
  soundAfter,
  soundOf,
  stillHeard,
} from './tab';

/** Observations in a row that must name the same viewing before a tab binds to it. */
export const STABLE_OBSERVATIONS = 2;

export interface ObservationInput {
  readonly tabId: number;
  readonly incognito: boolean;
  /** The site's built-in service, or `null` on a site without a module. */
  readonly serviceId: string | null;
  readonly frames: readonly FrameReport[];
}

export interface ObservationResult {
  /** The tab's viewing after the observation, or `null` when it has none. */
  readonly viewing: Viewing | null;
  /** This observation reported it. */
  readonly reported: boolean;
  /** This observation queued the viewing's start; absent when it did not. */
  readonly started?: true;
  /**
   * Why the observation's playing sample went nowhere, when that is another reason than the tab
   * had (the diagnostics log a change of reason once, not every observation).
   */
  readonly newlyIgnored?: IgnoredReason;
}

interface Deps {
  readonly viewings: ViewingStore;
  readonly settings: Settings;
  /** The account's rule, which decides when a film begun sends its start. */
  readonly rules: AccountRules;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly report: ReportViewing;
  readonly lock: ViewingLock;
  /** The account a viewing is recorded for now (`keyOf` the stored connection). */
  readonly accountKey: () => Promise<AccountKey | null>;
}

/**
 * One observation of a tab (its frames' samples and readings) → sittings, viewings and the
 * report trigger. It runs inside the viewing lock, so two
 * observations of one viewing never read the same version of it.
 *
 * - A tab binds to a viewing only once the merged reading named it on
 *   `STABLE_OBSERVATIONS` observations in a row; it joins the open (or skipped) viewing of
 *   that key, or starts one. A sitting starts from the sample that binds it.
 * - A different identity that held still splits: the old viewing keeps its ranges, the new
 *   one starts empty. `applySample` is never handed a reading of another viewing.
 * - A reading that names the bound title more or less finely (a film's year, or the
 *   service's own title id, gained or lost — `sameTitleRefinement`) is the same identity,
 *   whatever the pause, while the media lengths agree (`lengthsAgree`): a coarser one joins
 *   at once; a finer one re-keys the viewing, keeping everything else, once it held still
 *   (`STABLE_OBSERVATIONS`) — until then its samples are recorded and its name is not. A
 *   new sitting finds its viewing by its key or, failing that, by its title (`titleKey`) at
 *   the same length. A yearless film and a remake of its title with the year, at two
 *   lengths, are two films.
 * - **A viewing is one service's.** A reading seen on another service — a module's or a
 *   site's without one, ids or none — never joins it, refines it or names nothing of its
 *   own for it; the key says so (`viewingKey` names the service).
 * - **A reading whose key is not the bound viewing's is decided only on a length the
 *   observation shows.** While that length is unknown (an ad, a pre-roll, a stream that
 *   reports none) it changes nothing: it re-keys nothing, binds nothing, and its samples go
 *   to the bound viewing only while the element is still on that viewing's media. A new
 *   sitting with such a reading waits — joins no title candidate and starts no viewing —
 *   until a length shows, unless no viewing of that title is open.
 * - A reading that names nothing of its own (a post-play screen without a title) is no new
 *   identity: it goes to the bound viewing, whose fields it carries, and starts nothing.
 * - **A reading that names another title by the service's own id is another identity, with
 *   a kind or without**: its title-level provider id differs from the bound
 *   viewing's, so none of its samples reach that viewing — not even on what may still be its
 *   media — and without a kind it starts nothing. Next to the rule above, "names nothing of
 *   its own" means no kind *and* no other title's id: a player whose controls are hidden
 *   after an autoplay still states the next episode's id.
 * - **The bound media's samples are the bound viewing's**, whatever the reading names but
 *   another title's own id. While the element may still be on that media (its length, at
 *   60 s or later, within 75 s of the viewing's last sample) no other viewing starts from it;
 *   a sample that continues its playback goes to it, and an end signal — a next-episode
 *   screen's `contentEnded`, the element's `ended` — ends it. A new episode loading breaks
 *   the rule at once.
 * - A viewing never starts from an end screen, nor from a player that is not playing. **A
 *   pause is the bound viewing's last sample**: the stretch played up to it counts, and
 *   nothing counts from it — the time a player stood still, and a seek made while it did, is
 *   never playback. A stopped player otherwise only shows the bound viewing ending.
 * - **Ad time changes nothing** (`isAdTime`): a sample whose element is shorter than content
 *   (`MIN_CONTENT_SECONDS`) — a pre-roll or a mid-roll in its own element, a muted preview, a
 *   billboard trailer — adds no coverage, ends nothing and binds nothing, and the timeline the
 *   content resumes from is the one before it.
 * - **Another service's sample is never the bound viewing's**, not even on media of its
 *   length: the tab left the service.
 * - **An element's `ended` ends a viewing only when it plays that viewing's media**
 *   (`applySample`): its length agrees with the length the viewing knows. A service's own end
 *   signal (`contentEnded`) is the service's word and stands as it is; the position where it
 *   first appears is the viewing's credits start where the service states none.
 * - **A muted element never starts a viewing**: a muted sample neither binds a
 *   sitting to a viewing nor opens one, however large the player. A viewing started with
 *   sound keeps counting its muted samples, so a person who mutes it later loses nothing;
 *   playback started muted and kept muted is not tracked.
 *   - **The next episode after a mute keeps tracking.** The tab state keeps the player heard
 *     with sound (`TabState.sound`: its frame, and when it last played), persisted, carried
 *     on by that frame's playback, muted or not, and gone after a gap longer than
 *     `MAX_SAMPLE_GAP_S`. A muted sample of that frame binds — opens a viewing, or joins one
 *     — when it names an episode of the tab's viewing's show on the same service
 *     (`sameShowOnService`). A frame id is not an element: a trailer on the next page in the
 *     same frame would pass "the same player" alone, so the show is what tells an autoplay
 *     from a trailer. Such a viewing is engaged only once its player fills `ENGAGED_AREA` of
 *     the viewport or is unmuted, as before.
 *   - **The election sticks to the open sitting**: the open sitting's frame
 *     (`TabState.sittingFrameId`, the frame whose sample last went to the tab's viewing)
 *     wins over every muted frame, playing or paused, so a muted preview playing while the
 *     viewing is paused elects the paused frame and changes nothing. An unmuted playing
 *     frame still comes first.
 * - **A sample from other media adds nothing** (`fromOtherMedia`): inside the
 *   sitting, an element whose length and the sitting's (`TabState.sittingLength`, element
 *   lengths of the taken samples while no ad showed) are both known and more than
 *   max(60 s, 2 %) apart adds no coverage to the bound viewing and ends nothing — a preview
 *   playing beside a paused player. It may still bind a new identity it names. After a gap
 *   longer than `MAX_SAMPLE_GAP_S` its length is a new sitting's.
 * - While tracking is paused, in an incognito tab without the setting, or on a service the
 *   person turned off, nothing changes. (Sites are checked before this, by the worker.)
 * - **A playing sample that reached no viewing says why** (`TabState.ignored`):
 *   the first of the core's gates it failed, in the order of `IGNORED_REASONS` — an ad, media
 *   too short to be content, a muted element that may not open one, a page that names nothing
 *   (`page_silent`, or `series_no_episode` for a series page or an episode without its numbers,
 *   from the frames' entry verdicts), a reading without a title, a reading that has not held
 *   still (`settling`, or a sitting waiting for a length). A sample that binds or reaches a
 *   viewing clears it; a paused one leaves it as it is. Ad time inside the bound viewing's
 *   sitting is that sitting's ad break, and says nothing.
 * - **The account's lines decide what is sent, and when.** A viewing's play goes in the
 *   observation whose story seconds played reach the finish line (`reportVerdict`), wherever in
 *   the story that is, and only once. A film begun sends its start once they reach the start
 *   line (`dueStart`): one per viewing, under a key of its own. An observation that reports the
 *   viewing's play sends no start with it.
 */
export class IngestObservation {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  execute(input: ObservationInput): Promise<ObservationResult> {
    return this.#deps.lock.run((held) => this.#observe(input, held));
  }

  /**
   * A playing sample the worker dropped before the core, kept as the tab's reason
   * (`not_player_page`). `true` when the tab had another reason.
   */
  ignore(tabId: number, reason: IgnoredReason): Promise<boolean> {
    return this.#deps.lock.run(async () => {
      const { viewings, clock } = this.#deps;
      const now = clock.now();
      const tab = (await viewings.tabState(tabId)) ?? emptyTab(tabId, now);
      await viewings.putTabState({ ...tab, ignored: { reason, at: now }, observedAt: now });
      return ignoredOf(tab.ignored)?.reason !== reason;
    });
  }

  async #observe(input: ObservationInput, held: LockHeld): Promise<ObservationResult> {
    const { viewings, settings, clock } = this.#deps;
    const config = await settings.get();
    const now = clock.now();
    if (!trackingAllowed(config, input, now)) return { viewing: null, reported: false };

    const tab = (await viewings.tabState(input.tabId)) ?? emptyTab(input.tabId, now);
    const bound = tab.viewingId === null ? null : await viewings.byId(tab.viewingId);
    const elected = electFor(input.frames, tab, bound);
    const sample = elected?.player.sample ?? null;
    if (elected === null || sample === null) return { viewing: bound, reported: false };
    const seen = observed({ input, tab, bound, elected, sample, now });
    // Media too short to be content is ad time: a pre-roll or a mid-roll in its
    // own element, a preview, a billboard trailer. It adds no coverage, ends nothing and binds
    // nothing — not even the timeline, which the content resumes from after the ad.
    if (isAdTime(sample)) return this.#adTime(seen);

    const decided = decide(seen);
    const { viewing, taken } = await this.#take(decided.route, seen);
    // Why a playing sample went nowhere; one that was taken clears it.
    const why = taken ? null : seen.playing ? whyIgnoredOf(seen, decided) : undefined;
    if (viewing !== null && viewing !== bound) await viewings.put(viewing);
    await viewings.putTabState(tabAfter(seen, decided, { viewing, taken, why }));

    const unsent: ObservationResult = { viewing, reported: false, ...changed(tab, why) };
    if (viewing?.state !== 'open' || !reportAllowed(viewing, config)) return unsent;
    return this.#send(viewing, unsent, input.tabId, held);
  }

  /**
   * Ad time: it changes no viewing. What the page says while it plays still counts towards
   * holding still — the page's reading is the page's, whichever element plays — and a playing
   * ad gives the tab its reason, unless it is the bound viewing's sitting's own ad break.
   */
  async #adTime(seen: Observed): Promise<ObservationResult> {
    const { tab, bound, sample, reading, playing, settled, now } = seen;
    if (!playing) return { viewing: bound, reported: false };
    const adBreak = bound !== null && continuesSitting(tab.lastSample, sample);
    const why = adBreak ? undefined : adShowing(sample, reading) ? 'ad' : 'short';
    await this.#deps.viewings.putTabState({
      ...settled,
      ...ignoring(tab, why, now),
      observedAt: now,
    });
    return { viewing: bound, reported: false, ...changed(tab, why) };
  }

  /**
   * The route carried out: the bound viewing with the sample applied, or the viewing the sample
   * binds. `taken` says whether the sample went to the tab's viewing (or the bound one kept it);
   * a sitting that waits for a length (`#join`) takes nothing.
   */
  async #take(route: Route, seen: Observed): Promise<{ viewing: Viewing | null; taken: boolean }> {
    const { input, tab, bound, sample, reading } = seen;
    switch (route.kind) {
      case 'ignore':
        return { viewing: bound, taken: false };
      case 'keep':
        return { viewing: bound, taken: true };
      case 'apply':
        return {
          viewing: this.#apply(route.viewing, tab.lastSample, sample, route.reading, input),
          taken: true,
        };
      case 'bind': {
        const started = await this.#bind(route.key, input, sample, reading);
        return started === null
          ? { viewing: bound, taken: false }
          : { viewing: started, taken: true };
      }
    }
  }

  /**
   * What the account's lines send for the open viewing as this observation left it: its play,
   * once the story seconds played reach the finish line; else, for a film begun, its start once
   * they reach the start line; else nothing (`unsent`).
   */
  async #send(
    viewing: Viewing,
    unsent: ObservationResult,
    tabId: number,
    held: LockHeld,
  ): Promise<ObservationResult> {
    const { viewings, rules, report } = this.#deps;
    // The account's lines, in force now, as the connection check kept them: read only when one
    // may apply. Both are drawn on the story, so a viewing whose length is unknown has none yet.
    if (storySeconds(viewing) === null) return unsent;
    const rule = await rules.get();
    if (reportVerdict(viewing, rule.finishThresholdPercent).kind === 'report') {
      await report.executeHeld(viewing, held, { tabId, rule });
      const after = (await viewings.byId(viewing.id)) ?? viewing;
      return { viewing: after, reported: after.state === 'reported' };
    }
    // A viewing whose play this observation sent sends no start: a film added needs no saving in
    // progress. Asked of the viewing just stored, under the lock, before the report reads it
    // back: a film whose start is not due costs no read.
    if (dueStart(viewing, rule) !== null && (await report.startHeld(viewing, held, rule))) {
      const after = (await viewings.byId(viewing.id)) ?? viewing;
      return { ...unsent, viewing: after, started: true };
    }
    return unsent;
  }

  #apply(
    v: Viewing,
    previous: PlaybackSample | null,
    sample: PlaybackSample,
    reading: MergedReading,
    input: ObservationInput,
  ): Viewing {
    // As it is, re-keyed when the reading names its title more finely, or, for a reading of
    // another title or another service (the bound media's samples), the sample alone.
    const target = joinTarget(v, reading, input.serviceId, mediaLength(sample, reading));
    const applied =
      target === null
        ? applySample(v, previous, sample, NOTHING)
        : applySample(target, previous, sample, reading);
    return input.incognito && !applied.incognito ? { ...applied, incognito: true } : applied;
  }

  /**
   * Where a new sitting of this reading goes: the open viewing of its key, else one of its
   * title whose lengths agree with the media the sitting starts on (`join`); `wait` while
   * such a viewing may be the one but the seen length cannot say (an ad, a pre-roll);
   * otherwise a viewing of its own (`start`). An open viewing whose show year the reading
   * contradicts is another show's, even under the same key (a remake): it is passed over, and
   * the two shows keep a viewing each.
   */
  async #join(
    key: ViewingKey,
    input: ObservationInput,
    sample: PlaybackSample,
    reading: MergedReading,
  ): Promise<Joined> {
    const { viewings } = this.#deps;
    const exact = await viewings.open(key);
    if (exact !== null && !contradictsShowYear(exact, reading)) {
      return { kind: 'join', viewing: exact };
    }
    const title = titleKey(reading);
    if (title === null) return START;
    const seen = mediaLength(sample, reading);
    let undecided = false;
    for (const v of await viewings.openByTitle(title)) {
      if (contradictsShowYear(v, reading)) continue;
      const names = sameTitleRefinement(v, reading, input.serviceId, seen);
      if (names === true) return { kind: 'join', viewing: v };
      if (names === null) undecided = true;
    }
    return undecided ? WAIT : START;
  }

  /** The sitting bound, or `null` when it waits (`#join`): nothing joined, nothing started. */
  async #bind(
    key: ViewingKey,
    input: ObservationInput,
    sample: PlaybackSample,
    reading: MergedReading,
  ): Promise<Viewing | null> {
    const { ids, accountKey } = this.#deps;
    const joined = await this.#join(key, input, sample, reading);
    if (joined.kind === 'wait') return null;
    const started =
      joined.kind === 'join'
        ? null
        : newViewing({
            id: ids.viewingId(),
            serviceId: input.serviceId,
            reading,
            at: sample.at,
            incognito: input.incognito,
          });
    // A new viewing is recorded for the account connected now, as its play will be.
    const base =
      joined.kind === 'join'
        ? joined.viewing
        : started === null
          ? null
          : { ...started, accountKey: await accountKey() };
    if (base === null) return null;
    // A sitting starts from the sample that binds it: the previous one was another's.
    return this.#apply(base, null, sample, reading, input);
  }
}

/** Where a new sitting goes (`#join`). */
type Joined =
  | { readonly kind: 'join'; readonly viewing: Viewing }
  | { readonly kind: 'start' }
  | { readonly kind: 'wait' };

const START: Joined = { kind: 'start' };
const WAIT: Joined = { kind: 'wait' };

/** An ad shows: the element's own signal, or the reading's (a module's, a page's). */
const adShowing = (s: PlaybackSample, r: MergedReading): boolean =>
  s.adPlaying || r.adPlaying === true;

/**
 * Why a playing sample that reached no viewing went nowhere: the first of the core's
 * gates after ad time (`isAdTime`, before this) that it fails, in the order of `IGNORED_REASONS`;
 * `null` when none did — a preview beside the paused sitting, an end screen, the bound media's
 * own undecided samples — which the bound viewing explains.
 */
function whyIgnored(o: {
  readonly sample: PlaybackSample;
  readonly reading: MergedReading;
  readonly key: ViewingKey | null;
  readonly frames: readonly FrameReport[];
  readonly mutedMayOpen: boolean;
  readonly settling: boolean;
}): IgnoredReason | null {
  const r = o.reading;
  if (adShowing(o.sample, r)) return 'ad';
  if (o.sample.muted && !o.mutedMayOpen) return 'muted';
  // Nothing named: the page failed the entry rule (its verdict says which way), or, on a module's
  // site, nothing on its player route said what plays.
  if (r.kind === undefined) {
    return o.frames.some((f) => f.entry === 'series') ? 'series_no_episode' : 'page_silent';
  }
  if (o.key === null) {
    return r.kind === 'episode' && (r.season === undefined || r.episode === undefined)
      ? 'series_no_episode'
      : 'no_title';
  }
  return o.settling ? 'settling' : null;
}

/** `newlyIgnored` when `why` is a reason the tab did not have. */
const changed = (
  tab: TabState,
  why: IgnoredReason | null | undefined,
): Pick<ObservationResult, 'newlyIgnored'> =>
  why != null && ignoredOf(tab.ignored)?.reason !== why ? { newlyIgnored: why } : {};

/** One observation as `#observe` reads it, once a frame with a sample was elected. */
interface Observed {
  readonly input: ObservationInput;
  readonly tab: TabState;
  readonly bound: Viewing | null;
  readonly elected: ElectedFrame;
  readonly sample: PlaybackSample;
  readonly reading: MergedReading;
  readonly playing: boolean;
  readonly key: ViewingKey | null;
  /** The tab with this reading counted towards holding still (`settle`). */
  readonly settled: TabState;
  readonly now: EpochMs;
}

function observed(
  seen: Pick<Observed, 'input' | 'tab' | 'bound' | 'elected' | 'sample' | 'now'>,
): Observed {
  const { input, tab, bound, elected, sample, now } = seen;
  const reading = elected.reading;
  const playing = !sample.paused && !sample.ended;
  const key = viewingKey(input.serviceId, reading);
  const settled = playing ? settle(tab, input.serviceId, key, reading) : tab;
  return { input, tab, bound, elected, sample, reading, playing, key, settled, now };
}

/**
 * The frame the observation is about. The open sitting's frame wins over every muted frame,
 * playing or paused: a muted preview playing while the viewing is paused elects the paused
 * frame. With a viewing bound, a stopped frame is elected too, so its end reaches the viewing.
 */
function electFor(
  frames: readonly FrameReport[],
  tab: TabState,
  bound: Viewing | null,
): ElectedFrame | null {
  const sittingFrameId = bound === null ? null : sittingFrameOf(tab);
  return (
    electFrame(frames, { sittingFrameId }) ??
    (bound === null ? null : electFrame(frames, { includeStopped: true, sittingFrameId }))
  );
}

/** Where the sample goes, and what decided it. */
interface Decided {
  readonly route: Route;
  readonly frameId: number;
  /** The player heard with sound, as the tab kept it before this sample. */
  readonly heard: SoundedPlayer | null;
  readonly mutedMayOpen: boolean;
  readonly heldStill: boolean;
}

function decide(seen: Observed): Decided {
  const { input, tab, bound, elected, sample, reading, key, settled } = seen;
  const frameId = elected.player.frameId;
  const heard = soundOf(tab);
  // A muted sample may open the next episode of the tab's show on the player that was heard
  // with sound in this stretch of playback, and nothing else.
  const mutedMayOpen =
    bound !== null &&
    stillHeard(heard, frameId, sample) &&
    sameShowOnService(bound, reading, input.serviceId);
  const heldStill =
    key !== null &&
    settled.stableCount >= STABLE_OBSERVATIONS &&
    settled.pendingReading !== null &&
    viewingKey(input.serviceId, settled.pendingReading) === key;
  const route = routeOf({
    // A sample whose element is not the sitting's media adds nothing.
    otherMedia:
      bound !== null &&
      fromOtherMedia(tab, sample, reading, sittingHeldElsewhere(tab, input.frames, frameId)),
    mutedMayOpen,
    bound,
    last: tab.lastSample,
    heldStill,
    key,
    reading,
    serviceId: input.serviceId,
    sample,
    playing: seen.playing,
  });
  return { route, frameId, heard, mutedMayOpen, heldStill };
}

/** Why a playing sample that reached no viewing went nowhere (`whyIgnored`). */
function whyIgnoredOf(seen: Observed, decided: Decided): IgnoredReason | null {
  return whyIgnored({
    sample: seen.sample,
    reading: seen.reading,
    key: seen.key,
    frames: seen.input.frames,
    mutedMayOpen: decided.mutedMayOpen,
    // Held still, and still not bound: the sitting waits for a length (`#join`).
    settling: !decided.heldStill || decided.route.kind === 'bind',
  });
}

/** The tab after the observation: its viewing, its timeline, its sound and its reason. */
function tabAfter(
  seen: Observed,
  decided: Decided,
  outcome: {
    readonly viewing: Viewing | null;
    readonly taken: boolean;
    readonly why: IgnoredReason | null | undefined;
  },
): TabState {
  const { tab, sample, reading, settled, now } = seen;
  const { taken } = outcome;
  return {
    ...settled,
    ...ignoring(tab, outcome.why, now),
    viewingId: outcome.viewing?.id ?? null,
    // Only a sample that went to the tab's viewing is the timeline the next one continues.
    lastSample: taken ? sample : tab.lastSample,
    sittingFrameId: taken ? decided.frameId : sittingFrameOf(tab),
    sittingLength: taken
      ? lengthAfter(tab, sample, reading, decided.route.kind === 'bind')
      : sittingLengthOf(tab),
    // Persisted: the worker may stop between an episode heard with sound and the next.
    sound: seen.playing ? soundAfter(decided.heard, decided.frameId, sample) : decided.heard,
    observedAt: now,
  };
}

function trackingAllowed(config: SettingsValue, input: ObservationInput, now: EpochMs): boolean {
  if (isPaused(config.pausedUntil, now)) return false;
  if (input.incognito && !config.trackIncognito) return false;
  return input.serviceId === null || !config.disabledServices.includes(input.serviceId);
}
