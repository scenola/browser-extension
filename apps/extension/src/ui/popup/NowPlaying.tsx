/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Now playing*: what the page says is playing — the extension knows nothing else —
// how far it has got, and one state line: *Added at 70 %* (the account's finish line, where the
// viewing is added the moment it is reached) · *Added* · *Not tracked on this site* ·
// *Scenola doesn't track this site* · *Skipped*.
// *Skip* is the person's to volunteer: "don't add this viewing". *Track this site* is the site
// card's (`SiteCard`), which reads the tab's site whether or not anything plays.
//
// Something that plays and is not tracked says why: the reason in one line, a line
// of detail where one helps, and the one action that does — *Send a page sample* for a page that
// names nothing the extension reads, *Open settings* for a service turned off. A viewing the play
// builder would refuse says it won't be added, in the same words, and offers the sample in place
// of *Skip*: there is nothing to skip.

import type { IgnoredReason } from '@mt/core';
import { useState } from 'preact/hooks';

import { t } from '../../i18n/t';
import type { AppMessageKey } from '../../i18n/t';
import type { NowPlaying as NowPlayingState, UiResponse } from '../../messaging/protocol';
import { Button } from '../components/Button';
import { ProgressBar } from '../components/ProgressBar';
import { StatusLine } from '../components/StatusLine';
import { progressMinutes, splitLabel } from '../format';
import { SETTINGS_ANCHORS } from '../settings-anchors';
import type { SettingsAnchor } from '../settings-anchors';
import type { UiAsk } from '../store';

/** The places in Settings a reason can send the person to; the others are linked from elsewhere. */
type Fix = Extract<SettingsAnchor, 'capture' | 'services'>;

/** Each reason in words, the line of detail some carry, and the place in Settings that helps. */
const REASONS: Readonly<
  Record<
    IgnoredReason,
    { readonly line: AppMessageKey; readonly detail?: AppMessageKey; readonly fix?: Fix }
  >
> = {
  tracking_paused: { line: 'popup.now.state.paused' },
  incognito: { line: 'popup.reason.incognito', detail: 'popup.reason.incognito_detail' },
  service_off: { line: 'popup.reason.service_off', fix: SETTINGS_ANCHORS.services },
  not_player_page: {
    line: 'popup.reason.not_player_page',
    detail: 'popup.reason.not_player_page_detail',
  },
  ad: { line: 'popup.reason.ad' },
  short: { line: 'popup.reason.short' },
  muted: { line: 'popup.reason.muted' },
  page_silent: { line: 'popup.reason.page_silent', fix: SETTINGS_ANCHORS.capture },
  series_no_episode: { line: 'popup.reason.series_no_episode', fix: SETTINGS_ANCHORS.capture },
  no_title: { line: 'popup.reason.no_title' },
  settling: { line: 'popup.reason.settling' },
  player_unreachable: {
    line: 'popup.reason.player_unreachable',
    detail: 'popup.reason.player_unreachable_detail',
  },
};

/** What each place in Settings is offered as. */
const FIXES: Readonly<Record<Fix, AppMessageKey>> = {
  capture: 'popup.now.send_sample',
  services: 'popup.site.open_settings',
};

export function NowPlaying({
  playing,
  paused,
  finishPercent,
  send,
  onOpenSettings,
}: {
  readonly playing: NowPlayingState;
  readonly paused: boolean;
  /** The account's finish line, as the worker last read it: the share *Added at* names. */
  readonly finishPercent: number;
  readonly send: (ask: UiAsk) => Promise<UiResponse>;
  readonly onOpenSettings: (anchor: SettingsAnchor) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [skipFailed, setSkipFailed] = useState(false);
  const identified =
    playing.state === 'tracking' || playing.state === 'added' || playing.state === 'skipped';
  const why = whyOf(playing);
  const reason = why === null ? null : REASONS[why];
  const fix = reason?.fix;

  const skip = (viewingId: string): void => {
    setBusy(true);
    setSkipFailed(false);
    void send({ type: 'ui/skip', viewingId }).then((response) => {
      setBusy(false);
      if (!response.ok) setSkipFailed(true);
    });
  };

  return (
    <section aria-labelledby="now-playing-heading" class="px-4 pt-4 pb-4">
      <h2 id="now-playing-heading" class="text-micro font-semibold text-muted-foreground">
        {identified
          ? t('popup.now.heading', { service: playing.serviceName })
          : t('popup.now.site', { service: playing.serviceName })}
      </h2>

      {identified ? <Title playing={playing} /> : null}

      {identified && playing.progress !== null ? (
        <div class="mt-3">
          <Progress position={playing.progress.position} duration={playing.progress.duration} />
        </div>
      ) : null}

      <div class="mt-3 flex min-h-8 items-center justify-between gap-3">
        <StateLine playing={playing} paused={paused} finishPercent={finishPercent} />
        {fix !== undefined ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onOpenSettings(fix);
            }}
          >
            {t(FIXES[fix])}
          </Button>
        ) : playing.state === 'tracking' && playing.viewingId !== null && why === null ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (playing.viewingId !== null) skip(playing.viewingId);
            }}
            aria-describedby="now-playing-heading"
          >
            {t('popup.now.skip')}
          </Button>
        ) : null}
      </div>

      {/* A viewing that won't be added says why; something not tracked, what would help. */}
      {reason === null ? null : (
        <ReasonDetail reason={reason} wontAdd={playing.state === 'tracking'} />
      )}

      {skipFailed ? (
        <p role="alert" class="mt-2 text-caption text-muted-foreground">
          {t('popup.now.skip_failed')}
        </p>
      ) : null}
    </section>
  );
}

/** Why it is not tracked, or why the viewing won't be added; `null` for neither. */
function whyOf(playing: NowPlayingState): IgnoredReason | null {
  if (playing.state === 'not_tracking') return playing.reason;
  return playing.state === 'tracking' ? playing.problem : null;
}

/** What plays, as the page says it: the title, and the label with the episode's own title. */
function Title({ playing }: { readonly playing: NowPlayingState }) {
  const { title, detail } = splitLabel(playing.label);
  return (
    <div class="mt-1.5">
      <p class="font-display text-display-m font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">
        {title === '' ? t('popup.now.untitled') : title}
      </p>
      {detail === '' ? null : (
        <p class="mt-0.5 text-body-s text-muted-foreground [overflow-wrap:anywhere]">
          {playing.episodeTitle === null ? detail : `${detail} · ${playing.episodeTitle}`}
        </p>
      )}
    </div>
  );
}

/**
 * The line under the state: a viewing that won't be added says why (the state line says only
 * that it won't); a reason that carries a line of detail says it.
 */
function ReasonDetail({
  reason,
  wontAdd,
}: {
  readonly reason: (typeof REASONS)[IgnoredReason];
  readonly wontAdd: boolean;
}) {
  const key = wontAdd ? reason.line : reason.detail;
  return key === undefined ? null : <p class="mt-1 text-caption text-muted-foreground">{t(key)}</p>;
}

function Progress({
  position,
  duration,
}: {
  readonly position: number;
  readonly duration: number;
}) {
  const minutes = progressMinutes(position, duration);
  const text = t('popup.now.progress', { position: minutes.position, duration: minutes.duration });
  return (
    <ProgressBar
      value={position}
      max={duration}
      label={t('popup.now.progress_label')}
      text={text}
    />
  );
}

function StateLine({
  playing,
  paused,
  finishPercent,
}: {
  readonly playing: NowPlayingState;
  readonly paused: boolean;
  readonly finishPercent: number;
}) {
  switch (playing.state) {
    case 'tracking':
      return paused ? (
        <StatusLine icon="pause" tone="muted">
          {t('popup.now.state.paused')}
        </StatusLine>
      ) : playing.problem !== null ? (
        <StatusLine icon="circle" tone="muted">
          {t('popup.now.state.wont_add')}
        </StatusLine>
      ) : (
        <StatusLine icon="live">
          {t('popup.now.state.tracking', { percent: finishPercent })}
        </StatusLine>
      );
    case 'not_tracking':
      return (
        <StatusLine icon={playing.reason === 'tracking_paused' ? 'pause' : 'circle'} tone="muted">
          {playing.reason === null ? '' : t(REASONS[playing.reason].line)}
        </StatusLine>
      );
    case 'added':
      return <StatusLine icon="check">{t('popup.now.state.added')}</StatusLine>;
    case 'skipped':
      return (
        <StatusLine icon="skip" tone="muted">
          {t('popup.now.state.skipped')}
        </StatusLine>
      );
    case 'not_tracked':
      return (
        <StatusLine icon="circle" tone="muted">
          {t('popup.now.state.not_tracked')}
        </StatusLine>
      );
    case 'blocked':
      return (
        <StatusLine icon="blocked" tone="muted">
          {t('status.blocked')}
        </StatusLine>
      );
  }
}
