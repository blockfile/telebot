import type { WatchedToken } from './watchlist';
import type { CheckResults, Unknown } from './scoring';
import type { DevHistory } from '../checks/devHistory';
import type { Liveness } from '../checks/liveness';
import type { LaunchAnalysis } from '../checks/launchAnalysis';
import { normalizeTwitterHandle, normalizeUrl } from '../checks/socials';

export interface DeepCheckDeps {
  fetchDevHistory(creator: string, mint: string): Promise<DevHistory | 'unknown'>;
  isRugLinked(wallet: string): boolean;
  fetchTop10Pct(mint: string, bondingCurveKey: string): Promise<number | 'unknown'>;
  checkUrlAlive(url: string): Promise<Liveness>;
  checkXExists(handle: string): Promise<Liveness>;
  analyzeLaunch(mint: string, bondingCurveKey: string, creator: string, creationSignature: string): Promise<LaunchAnalysis | 'unknown'>;
  fetchHolderCount(mint: string, bondingCurveKey: string): Promise<number | 'unknown'>;
}

const UNKNOWN = Promise.resolve('unknown' as const);

export async function runDeepChecks(t: WatchedToken, deps: DeepCheckDeps): Promise<CheckResults> {
  const handle = t.meta.twitter ? normalizeTwitterHandle(t.meta.twitter) : null;

  const [devHistory, top10Pct, twitterAlive, telegramAlive, websiteAlive, xExists, launch, holderCount] = await Promise.all([
    deps.fetchDevHistory(t.event.creator, t.event.mint),
    deps.fetchTop10Pct(t.event.mint, t.event.bondingCurveKey),
    t.meta.twitter ? deps.checkUrlAlive(normalizeUrl(t.meta.twitter)) : UNKNOWN,
    t.meta.telegram ? deps.checkUrlAlive(normalizeUrl(t.meta.telegram)) : UNKNOWN,
    t.meta.website ? deps.checkUrlAlive(normalizeUrl(t.meta.website)) : UNKNOWN,
    handle ? deps.checkXExists(handle) : UNKNOWN,
    deps.analyzeLaunch(t.event.mint, t.event.bondingCurveKey, t.event.creator, t.event.signature),
    deps.fetchHolderCount(t.event.mint, t.event.bondingCurveKey),
  ]);

  let funderLinkedToRug: Unknown<boolean> = 'unknown';
  if (devHistory !== 'unknown' && devHistory.funder) {
    funderLinkedToRug = deps.isRugLinked(devHistory.funder);
  }

  return {
    devHistory: devHistory === 'unknown'
      ? 'unknown'
      : { priorLaunches: devHistory.priorLaunches, anyGraduated: devHistory.anyGraduated },
    funderLinkedToRug,
    top10Pct,
    twitterAlive,
    telegramAlive,
    websiteAlive,
    xExists,
    devStillHolds: !t.devSold,
    bundlePct: launch === 'unknown' ? 'unknown' : launch.bundlePct,
    first20Pct: launch === 'unknown' ? 'unknown' : launch.first20Pct,
    devOutflowPct: launch === 'unknown' ? 'unknown' : launch.devOutflowPct,
    sniperCount: launch === 'unknown' ? 'unknown' : launch.sniperCount,
    sniperPct: launch === 'unknown' ? 'unknown' : launch.sniperPct,
    sniperHeldPct: launch === 'unknown' ? 'unknown' : launch.sniperHeldPct,
    bundleCount: launch === 'unknown' ? 'unknown' : launch.bundleCount,
    bundleHeldPct: launch === 'unknown' ? 'unknown' : launch.bundleHeldPct,
    holderCount,
  };
}
