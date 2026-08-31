// compare.ts — the verdict pipeline: fuses per-clip profiles into a structured
// comparison result with weighted votes, verdict, confidence, and explanation.
import { thinnessMargin, type BaselineMode } from './channel';
import type { ClipProfile, ProbeReading } from './features';
import {
  compareVoicePanel,
  f0SemitoneDistanceOf,
  mfccVoiceCosine,
  type VoicePanel,
} from './voice';

export type Verdict = 'MATCH' | 'SUSPICIOUS RELAY' | 'UNCERTAIN';
export type RelayState = 'GREEN' | 'AMBER' | 'RED';
export type SignalId =
  | 'voice'
  | 'channel'
  | 'spectral_integrity'
  | 'relay'
  | 'envelope'
  | 'spectral_smear'
  | 'noise_bed'
  | 'conversation'
  | 'probe';

export type IntegrityFlag = 'BASS_DEPLETED' | 'SPEECH_THIN';

/**
 * Strict spectral-integrity signal: thinness and bass depletion measured on
 * VAD-gated speech frames only. Any flag on B vetoes a clean MATCH verdict.
 */
export interface SpectralIntegritySignal {
  /** false when either clip has too few speech frames — no flag can fire */
  available: boolean;
  framesA: number;
  framesB: number;
  minSpeechFrames: number;
  /** low band measured, Hz: [80, 300] on good/okay, [300, 500] on poor
   * (sub-300 is channel-limited there, so the low-inband stands in) */
  bandHz: [number, number];
  /** speech low-band energy fractions (0..1 of speech energy) */
  lowBandA: number;
  lowBandB: number;
  /** (A − B)/A relative drop in low-band fraction */
  lowBandRelDrop: number;
  /** A − B absolute drop (fraction points; 0.005 = 0.5 pp) */
  lowBandAbsDrop: number;
  centroidA: number;
  centroidB: number;
  /** (A − B)/A relative drop in speech centroid */
  centroidRelDrop: number;
  p95A: number;
  p95B: number;
  /** (A − B)/A relative drop in speech p95 rolloff */
  p95RelDrop: number;
  bassDepleted: boolean;
  speechThin: boolean;
  flags: IntegrityFlag[];
  /** analyst-facing metric detail, reused by the vote and the explanation */
  detail: string;
}

export interface RelayFingerprint {
  score: number;
  state: RelayState;
  components: {
    flatness: number;
    gapContrast: number;
    noiseBed: number;
    hfLeakage: number;
    fragmentation: number;
  };
}

export interface VoiceSignal {
  mfccCosine: number;
  gatedSegments: number;
  f0SemitoneDistance: number;
  f0A: ClipProfile['f0'];
  f0B: ClipProfile['f0'];
  turnsA: { start_s: number; end_s: number }[];
  turnsB: { start_s: number; end_s: number }[];
}

export interface ChannelSignal {
  centroidA: number;
  centroidB: number;
  p95A: number;
  p95B: number;
  p99A: number;
  p99B: number;
  sub300A: number;
  sub300B: number;
  above3400A: number;
  above3400B: number;
  above4000A: number;
  above4000B: number;
  inbandA: number;
  inbandB: number;
  thinnessA: number;
  thinnessB: number;
  delta: number;
  margin: number;
  bThinnerThanA: boolean;
}

export interface EnvelopeSignal {
  available: boolean;
  /** true when the duty vote abstained because a noise bed is very_noisy —
   * the duty cue flips sign in noise and is only trustworthy paired with a
   * noise-bed measurement. */
  dutyGated: boolean;
  dutyA: number;
  dutyB: number;
  dutyDelta: number;
  burstsA: number;
  burstsB: number;
  burstCVA: number;
  burstCVB: number;
  burstCVDelta: number;
  gapDepthA: number;
  gapDepthB: number;
  dynamicRangeA: number;
  dynamicRangeB: number;
}

export interface SmearSignal {
  flatnessA: number;
  flatnessB: number;
  flatnessDelta: number;
  gapBurstA: number;
  gapBurstB: number;
  gapBurstDelta: number;
}

export interface NoiseSignal {
  a: ClipProfile['noise'];
  b: ClipProfile['noise'];
}

export interface ProbeSignal {
  /** probe reading per side (null when that clip was not recorded with the probe) */
  a: ProbeReading | null;
  b: ProbeReading | null;
  /** true when at least one clip was recorded under challenge noise */
  active: boolean;
}

export interface ConversationSignal {
  spectrumCorrelation: number;
  sharedContentLikely: boolean;
  dutyA: number;
  dutyB: number;
  turnsA: number;
  turnsB: number;
}

export interface SignalVote {
  id: SignalId;
  weight: number;
  vote: number; // +1 relay, 0 neutral, -1 match
  available: boolean;
  /** optional analyst-facing note (e.g. why a vote abstained) */
  detail?: string;
}

export interface ComparisonResult {
  baseline: BaselineMode;
  timestampIso: string;
  a: ClipProfile;
  b: ClipProfile;
  voice: VoiceSignal;
  /** 5-matcher voice-biometric panel and its consensus */
  voicePanel: VoicePanel;
  channel: ChannelSignal;
  spectralIntegrity: SpectralIntegritySignal;
  /** strict spectral-integrity flags fired on B (empty when clean/unavailable) */
  flags: IntegrityFlag[];
  /** true when an integrity flag escalated a would-be MATCH verdict */
  flagVetoed: boolean;
  /** 'voice_consensus' when a ≥3/5 same-voice panel consensus overrode the flag
   * veto (flags displayed as informational, MATCH allowed through), else null */
  flagOverride: 'voice_consensus' | null;
  /** true when a ≥3/5 different-voice panel consensus vetoed a would-be MATCH —
   * the voices are not the same person regardless of channel similarity */
  voiceVeto: boolean;
  relay: { a: RelayFingerprint; b: RelayFingerprint; voteRelay: boolean };
  envelope: EnvelopeSignal;
  spectralSmear: SmearSignal;
  noiseBed: NoiseSignal;
  probe: ProbeSignal;
  conversation: ConversationSignal;
  votes: SignalVote[];
  weightedScore: number; // -1..1
  maxWeightedScore: number;
  verdict: Verdict;
  confidence: number; // 0..100
  relayVotes: number;
  totalVotes: number;
  explanation: string;
  reducedConfidence: boolean;
}

// ---------------------------------------------------------------- helpers --

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function sigmoid(v: number): number {
  return 1 / (1 + Math.exp(-v));
}

function pearson(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 4) return NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da < 1e-20 || db < 1e-20) return NaN;
  return num / Math.sqrt(da * db);
}

function fmtHz(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${Math.round(v).toLocaleString('en-US').replace(/,/g, ' ')} Hz`;
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtDb(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v.toFixed(1)} dB`;
}

function fmt2(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return v.toFixed(2);
}

// ------------------------------------------------ spectral-integrity rules --

/** Minimum VAD speech frames per clip (≈ 0.26 s at the 32 ms hop). Below this
 * the integrity checks degrade gracefully: the row reports it, no flag fires. */
export const INTEGRITY_MIN_SPEECH_FRAMES = 8;
/** BASS_DEPLETED: relative low-band drop of B vs A on speech frames */
export const BASS_REL_DROP = 0.35;
/** BASS_DEPLETED: absolute low-band drop (0.5 percentage points) */
export const BASS_ABS_DROP = 0.005;
/** BASS_DEPLETED: absolute floor — low band under 0.4% of speech energy */
export const BASS_FLOOR = 0.004;
/** SPEECH_THIN: B's speech p95 rolloff this far below A's */
export const P95_REL_DROP = 0.12;
/** SPEECH_THIN: B's speech centroid this far below A's */
export const CENTROID_REL_DROP = 0.15;

function relDrop(a: number, b: number): number {
  return Number.isFinite(a) && Number.isFinite(b) && a > 1e-9 ? (a - b) / a : NaN;
}

/** Build the strict spectral-integrity signal from both speech profiles. */
function spectralIntegritySignal(
  a: ClipProfile,
  b: ClipProfile,
  baseline: BaselineMode,
): SpectralIntegritySignal {
  // On the poor baseline the channel strips sub-300 Hz fundamentals, so bass
  // is estimated from the 300–500 Hz low-inband region instead.
  const poorMode = baseline === 'poor';
  const bandHz: [number, number] = poorMode ? [300, 500] : [80, 300];
  const bandNote = poorMode
    ? ' — bass estimated from 300–500 Hz low-inband: the channel strips fundamentals'
    : '';
  const lowA = poorMode ? a.speech.lowInband : a.speech.lowBand;
  const lowB = poorMode ? b.speech.lowInband : b.speech.lowBand;
  const lowRel = relDrop(lowA, lowB);
  const lowAbs =
    Number.isFinite(lowA) && Number.isFinite(lowB) ? lowA - lowB : NaN;
  const centRel = relDrop(a.speech.centroidHz, b.speech.centroidHz);
  const p95Rel = relDrop(a.speech.p95Hz, b.speech.p95Hz);

  const available =
    a.speech.frames >= INTEGRITY_MIN_SPEECH_FRAMES &&
    b.speech.frames >= INTEGRITY_MIN_SPEECH_FRAMES;

  const bandLabel = `${bandHz[0]}–${bandHz[1]} Hz`;
  const sig: SpectralIntegritySignal = {
    available,
    framesA: a.speech.frames,
    framesB: b.speech.frames,
    minSpeechFrames: INTEGRITY_MIN_SPEECH_FRAMES,
    bandHz,
    lowBandA: lowA,
    lowBandB: lowB,
    lowBandRelDrop: lowRel,
    lowBandAbsDrop: lowAbs,
    centroidA: a.speech.centroidHz,
    centroidB: b.speech.centroidHz,
    centroidRelDrop: centRel,
    p95A: a.speech.p95Hz,
    p95B: b.speech.p95Hz,
    p95RelDrop: p95Rel,
    bassDepleted: false,
    speechThin: false,
    flags: [],
    detail: '',
  };

  if (!available) {
    sig.detail =
      `too few speech frames for the strict bass/thinness checks ` +
      `(A ${a.speech.frames}, B ${b.speech.frames}; need ≥ ${INTEGRITY_MIN_SPEECH_FRAMES} each) — no flag fires`;
    return sig;
  }

  const detailParts: string[] = [];
  // Bass depletion: relative drop (with a minimum absolute drop so tiny
  // fractions don't trigger on noise) OR an absolute floor breach.
  const relTrigger =
    Number.isFinite(lowRel) && lowRel >= BASS_REL_DROP && lowAbs >= BASS_ABS_DROP;
  const floorTrigger = Number.isFinite(lowB) && lowB < BASS_FLOOR;
  if (relTrigger || floorTrigger) {
    sig.bassDepleted = true;
    sig.flags.push('BASS_DEPLETED');
    detailParts.push(
      relTrigger
        ? `B's speech carries ${Math.round(lowRel * 100)}% less ${bandLabel} energy than A's ` +
          `(${fmtPct(lowB)} vs ${fmtPct(lowA)} of speech energy${bandNote}) — flagged BASS DEPLETED`
        : `B's speech ${bandLabel} energy reads ${fmtPct(lowB)} of speech energy, under the ` +
          `${fmtPct(BASS_FLOOR)} floor${bandNote} — flagged BASS DEPLETED`,
    );
  }
  // Speech thinness: p95 rolloff or centroid materially lower on B.
  const p95Trigger = Number.isFinite(p95Rel) && p95Rel >= P95_REL_DROP;
  const centTrigger = Number.isFinite(centRel) && centRel >= CENTROID_REL_DROP;
  if (p95Trigger || centTrigger) {
    sig.speechThin = true;
    sig.flags.push('SPEECH_THIN');
    const causes: string[] = [];
    if (p95Trigger)
      causes.push(
        `speech p95 ${fmtHz(sig.p95B)} vs A's ${fmtHz(sig.p95A)} (−${Math.round(p95Rel * 100)}%)`,
      );
    if (centTrigger)
      causes.push(
        `speech centroid ${fmtHz(sig.centroidB)} vs A's ${fmtHz(sig.centroidA)} (−${Math.round(centRel * 100)}%)`,
      );
    detailParts.push(`${causes.join('; ')} — flagged SPEECH THIN`);
  }

  sig.detail =
    detailParts.length > 0
      ? detailParts.join('. ') +
        '. Spectrograms below show the missing low band — the thinness signature'
      : `low band ${fmtPct(lowB)} vs A's ${fmtPct(lowA)} of speech energy ` +
        `(drop ${Number.isFinite(lowRel) ? Math.round(lowRel * 100) : 0}% < ${Math.round(BASS_REL_DROP * 100)}% rule), ` +
        `speech p95 ${fmtHz(sig.p95B)} vs ${fmtHz(sig.p95A)}, centroid ${fmtHz(sig.centroidB)} vs ${fmtHz(sig.centroidA)} ` +
        `— no bass/thinness flag${bandNote}`;
  return sig;
}

// ------------------------------------------------- relay fingerprint model --

/**
 * Heuristic relay fingerprint (stands in for the reference CNN):
 * fuses elevated spectral flatness, reduced gap–burst contrast, noisier bed,
 * elevated >3.4 kHz leakage and burst fragmentation into a 0–1 score.
 */
export function relayFingerprint(p: ClipProfile, probeOn = false): RelayFingerprint {
  // Spectral flatness on bursts: direct ≈ 0.003–0.03, relay climbs well above.
  const flat = Number.isFinite(p.burstFlatness) ? p.burstFlatness : p.flatnessAll;
  const flatness = sigmoid((Math.log10(Math.max(flat, 1e-5)) + 2.2) * 3.2);

  // Gap-vs-burst contrast: deep gaps (< -10 dB) = clean; shallow = smeared.
  const g = Number.isFinite(p.gapVsBurstDb) ? p.gapVsBurstDb : -8;
  const gapContrast = sigmoid((g + 7.5) / 1.8);

  // Noise bed: quiet < -55 dB, noisy > -35 dB.
  const bed = Number.isFinite(p.noise.bedDb) ? p.noise.bedDb : -60;
  let noiseBed = sigmoid((bed + 48) / 5);
  if (probeOn && Number.isFinite(p.noise.speechToBedDb)) {
    // With the probe on, the bed is deterministic enough to trust the
    // speech-to-bed margin: ≈ 8.5 dB = speakerphone drowning; a bed crushed
    // toward −67 dBFS gives a large margin = direct. Folded in additively —
    // never lowers the bed component, only raises it on a drowning signature.
    const marginComponent = sigmoid((14 - p.noise.speechToBedDb) / 3);
    noiseBed = Math.max(noiseBed, marginComponent);
  }

  // >3.4 kHz leakage (speakerphone HF hash)
  const hf = p.bands.above3400;
  const hfLeakage = sigmoid((hf - 0.05) * 55);

  // Burst fragmentation: bursts per second of speech (relay fragments turns).
  const speechSec = Math.max(0.25, p.vad.dutyCycle * p.duration);
  const perSec = p.vad.burstCount / speechSec;
  const fragmentation = sigmoid((perSec - 2.6) * 1.4);

  const score = clamp01(
    0.28 * flatness + 0.2 * gapContrast + 0.22 * noiseBed + 0.14 * hfLeakage + 0.16 * fragmentation,
  );
  const state: RelayState = score >= 0.6 ? 'RED' : score >= 0.35 ? 'AMBER' : 'GREEN';
  return { score, state, components: { flatness, gapContrast, noiseBed, hfLeakage, fragmentation } };
}

// ---------------------------------------------------------------- pipeline --

export function compareClips(
  a: ClipProfile,
  b: ClipProfile,
  baseline: BaselineMode,
): ComparisonResult {
  // --- voice ---
  // MFCC shape cosine + F0 distance come from the shared voice.ts helpers
  // (identical math to the legacy pipeline) so the panel and the vote agree.
  const mfccCosine = mfccVoiceCosine(a, b);
  const gatedSegments = Math.min(a.vad.burstCount, b.vad.burstCount);
  const f0Dist = f0SemitoneDistanceOf(a, b);
  // 5-matcher calibrated voice-biometric panel (see voice.ts for the exact
  // consensus rule: ≥3 same + 0 different → SAME; ≥3 different + 0 same → DIFFERENT).
  const voicePanel = compareVoicePanel(a, b, baseline);
  const voice: VoiceSignal = {
    mfccCosine,
    gatedSegments,
    f0SemitoneDistance: f0Dist,
    f0A: a.f0,
    f0B: b.f0,
    turnsA: a.vad.turns,
    turnsB: b.vad.turns,
  };

  // --- channel ---
  const margin = thinnessMargin(baseline);
  const delta = b.thinness - a.thinness;
  const channel: ChannelSignal = {
    centroidA: a.centroidHz,
    centroidB: b.centroidHz,
    p95A: a.p95Hz,
    p95B: b.p95Hz,
    p99A: a.p99Hz,
    p99B: b.p99Hz,
    sub300A: a.bands.sub300,
    sub300B: b.bands.sub300,
    above3400A: a.bands.above3400,
    above3400B: b.bands.above3400,
    above4000A: a.bands.above4000,
    above4000B: b.bands.above4000,
    inbandA: a.bands.inband,
    inbandB: b.bands.inband,
    thinnessA: a.thinness,
    thinnessB: b.thinness,
    delta,
    margin,
    bThinnerThanA: delta > margin,
  };

  // --- spectral integrity (strict bass/thinness on speech frames) ---
  const spectralIntegrity = spectralIntegritySignal(a, b, baseline);

  // --- probe readings (null when that side wasn't recorded with the probe) ---
  const probeA = a.probe?.on ? a.probe : null;
  const probeB = b.probe?.on ? b.probe : null;
  const probe: ProbeSignal = { a: probeA, b: probeB, active: Boolean(probeA || probeB) };

  // --- relay fingerprint ---
  const ra = relayFingerprint(a, probeA !== null);
  const rb = relayFingerprint(b, probeB !== null);
  const relayVoteRelay = rb.score - ra.score > 0.22;

  // --- envelope ---
  const envAvailable = a.vad.burstCount >= 2 && b.vad.burstCount >= 2;
  // Duty-cue gating: the duty cycle flips sign in noise, so when either bed is
  // very_noisy the duty vote must abstain regardless of burst availability.
  const dutyGated = a.noise.label === 'very_noisy' || b.noise.label === 'very_noisy';
  const envelope: EnvelopeSignal = {
    available: envAvailable,
    dutyGated,
    dutyA: a.vad.dutyCycle,
    dutyB: b.vad.dutyCycle,
    dutyDelta: b.vad.dutyCycle - a.vad.dutyCycle,
    burstsA: a.vad.burstCount,
    burstsB: b.vad.burstCount,
    burstCVA: a.vad.burstCV,
    burstCVB: b.vad.burstCV,
    burstCVDelta:
      Number.isFinite(a.vad.burstCV) && Number.isFinite(b.vad.burstCV)
        ? b.vad.burstCV - a.vad.burstCV
        : NaN,
    gapDepthA: a.vad.gapDepthDb,
    gapDepthB: b.vad.gapDepthDb,
    dynamicRangeA: a.vad.dynamicRangeDb,
    dynamicRangeB: b.vad.dynamicRangeDb,
  };

  // --- spectral smear ---
  const spectralSmear: SmearSignal = {
    flatnessA: a.burstFlatness,
    flatnessB: b.burstFlatness,
    flatnessDelta:
      Number.isFinite(a.burstFlatness) && Number.isFinite(b.burstFlatness)
        ? b.burstFlatness - a.burstFlatness
        : NaN,
    gapBurstA: a.gapVsBurstDb,
    gapBurstB: b.gapVsBurstDb,
    gapBurstDelta:
      Number.isFinite(a.gapVsBurstDb) && Number.isFinite(b.gapVsBurstDb)
        ? b.gapVsBurstDb - a.gapVsBurstDb
        : NaN,
  };

  // --- noise bed ---
  const noiseBed: NoiseSignal = { a: a.noise, b: b.noise };

  // --- conversation ---
  const corr = pearson(a.meanSpectrum, b.meanSpectrum);
  const conversation: ConversationSignal = {
    spectrumCorrelation: corr,
    sharedContentLikely: Number.isFinite(corr) && corr >= 0.72,
    dutyA: a.vad.dutyCycle,
    dutyB: b.vad.dutyCycle,
    turnsA: a.vad.burstCount,
    turnsB: b.vad.burstCount,
  };

  // --- votes ---
  const votes: SignalVote[] = [];

  // voice ×0.6 — strong match supports MATCH; poor match supports relay.
  // A 3/5+ panel consensus hardens the vote: 'same' forces a MATCH vote
  // (and arms the flag-veto override below); 'different' forces a relay vote.
  const voiceVote =
    voicePanel.consensus === 'same'
      ? -1
      : voicePanel.consensus === 'different'
        ? 1
        : mfccCosine >= 0.62
          ? -1
          : mfccCosine <= 0.45
            ? 1
            : 0;
  votes.push({
    id: 'voice',
    weight: 0.6,
    vote: voiceVote,
    available: gatedSegments >= 1,
    detail:
      voicePanel.consensus !== 'no_consensus'
        ? `voice panel consensus: ${voicePanel.agreeCount}/5 matchers say ` +
          `${voicePanel.consensus === 'same' ? 'SAME voice' : 'DIFFERENT voice'} ` +
          `(${voicePanel.abstainCount} abstain)` +
          (voicePanel.overrideEngaged ? ' — flag-veto override armed' : '') +
          (voicePanel.vetoEngaged ? ' — MATCH veto armed' : '')
        : `voice panel split: ${voicePanel.sameCount} same / ${voicePanel.differentCount} different / ${voicePanel.abstainCount} abstain`,
  });

  // channel ×1.0
  votes.push({
    id: 'channel',
    weight: 1.0,
    vote: delta > margin ? 1 : delta < -margin ? -1 : -1, // B not thinner → consistent with A's channel
    available: true,
  });

  // spectral integrity ×0.75 — strict bass/thinness flags on speech frames.
  // A fired flag always votes relay; a clean read votes with A's channel.
  votes.push({
    id: 'spectral_integrity',
    weight: 0.75,
    vote: spectralIntegrity.flags.length > 0 ? 1 : -1,
    available: spectralIntegrity.available,
    detail: spectralIntegrity.detail,
  });

  // relay ×0.5
  votes.push({
    id: 'relay',
    weight: 0.5,
    vote: relayVoteRelay ? 1 : ra.score - rb.score > 0.22 ? -1 : rb.state === 'GREEN' ? -1 : 0,
    available: true,
  });

  // envelope ×0.5 — relay compresses envelope: lower duty, shallower gaps.
  // Gated first by the noise bed: the duty cue flips sign in noise, so with a
  // very_noisy bed it abstains with a documented note.
  if (!envAvailable) {
    votes.push({ id: 'envelope', weight: 0.5, vote: 0, available: false });
  } else if (dutyGated) {
    votes.push({
      id: 'envelope',
      weight: 0.5,
      vote: 0,
      available: false,
      detail: 'duty cue gated: unreliable in noise (sign flips)',
    });
  } else {
    let ev = 0;
    const gapDelta =
      Number.isFinite(envelope.gapDepthA) && Number.isFinite(envelope.gapDepthB)
        ? envelope.gapDepthB - envelope.gapDepthA
        : 0;
    if (gapDelta > 2.5 || envelope.dutyDelta < -0.15) ev = 1;
    else if (gapDelta < -2.5) ev = -1;
    votes.push({ id: 'envelope', weight: 0.5, vote: ev, available: true });
  }

  // spectral smear — higher flatness on B = smeared. When the probe was used,
  // the probe band (500 Hz–6 kHz, non-speech frames) is the deterministic
  // measurement: weight the cue higher and vote on probe-band flatness
  // (noisy-room anchors: 0.1469 speakerphone vs 0.0034 direct — 43×).
  // Otherwise fall back to the existing burst-flatness behavior at ×0.5.
  const probeSmear =
    probe.active &&
    Number.isFinite(a.probeBandFlatness) &&
    Number.isFinite(b.probeBandFlatness);
  if (probeSmear) {
    const rel =
      a.probeBandFlatness > 1e-6 ? b.probeBandFlatness / a.probeBandFlatness : NaN;
    let sv = 0;
    if (Number.isFinite(rel) && rel > 1.8) sv = 1;
    else if (Number.isFinite(rel) && rel < 0.6) sv = -1;
    votes.push({
      id: 'spectral_smear',
      weight: 0.75,
      vote: sv,
      available: true,
      detail: 'probe-band smear (weighted ×0.75 — challenge noise active)',
    });
  } else if (Number.isFinite(spectralSmear.flatnessDelta)) {
    const rel =
      Number.isFinite(a.burstFlatness) && a.burstFlatness > 1e-6
        ? b.burstFlatness / a.burstFlatness
        : NaN;
    let sv = 0;
    if (Number.isFinite(rel) && rel > 1.8) sv = 1;
    else if (Number.isFinite(rel) && rel < 0.6) sv = -1;
    votes.push({ id: 'spectral_smear', weight: 0.5, vote: sv, available: true });
  } else {
    votes.push({ id: 'spectral_smear', weight: 0.5, vote: 0, available: false });
  }

  // probe ×0.5 — only when at least one clip was recorded under challenge
  // noise. Probe response fidelity: a direct path preserves the probe shape
  // (GREEN ≥ 0.75); a speakerphone relay smears it (RED < 0.5).
  if (probe.active) {
    const fidelityB = probeB?.fidelity ?? NaN;
    let pv = 0;
    let pvAvailable = true;
    if (Number.isFinite(fidelityB)) {
      if (fidelityB < 0.5) pv = 1;
      else if (fidelityB >= 0.75) pv = -1;
    } else if (probeA && Number.isFinite(probeA.fidelity)) {
      // only A carried the probe: treat a smeared A as ambient-noise context
      pv = 0;
    } else {
      pvAvailable = false;
    }
    votes.push({
      id: 'probe',
      weight: 0.5,
      vote: pv,
      available: pvAvailable,
      detail: Number.isFinite(fidelityB)
        ? `probe response fidelity ${fidelityB.toFixed(2)} (${probeB?.fidelityState ?? 'AMBER'})`
        : 'probe fidelity unavailable — too little probe-dominant audio',
    });
  }

  // conversation ×0.5 — shared content is neutral-to-match evidence; divergence is suspicious
  votes.push({
    id: 'conversation',
    weight: 0.5,
    vote: conversation.sharedContentLikely ? -1 : Number.isFinite(corr) && corr < 0.45 ? 1 : 0,
    available: Number.isFinite(corr),
  });

  // --- weighted score ---
  let wsum = 0;
  let wmax = 0;
  let relayVotes = 0;
  let totalVotes = 0;
  for (const v of votes) {
    if (!v.available) continue;
    wsum += v.vote * v.weight;
    wmax += v.weight;
    totalVotes++;
    if (v.vote > 0) relayVotes++;
  }
  const weightedScore = wmax > 0 ? wsum / wmax : 0;

  const reducedConfidence =
    a.duration < 1.5 || b.duration < 1.5 || !envAvailable || gatedSegments < 2;

  let verdict: Verdict;
  if (weightedScore >= 0.2) verdict = 'SUSPICIOUS RELAY';
  else if (weightedScore <= -0.2) verdict = 'MATCH';
  else verdict = 'UNCERTAIN';

  // Flag veto: a fired spectral-integrity flag on B can never pass as a clean
  // MATCH — escalate to UNCERTAIN, or SUSPICIOUS RELAY when the channel vote
  // also fired (B thinner than A past the halved margin).
  // USER RULE — voice-consensus override: when the 5-matcher panel reaches a
  // ≥3/5 same-voice consensus, the veto is overridden. Flags stay computed and
  // displayed (informational only); the MATCH verdict stands and flagOverride
  // records 'voice_consensus' instead of flagVetoed.
  let flagVetoed = false;
  let flagOverride: 'voice_consensus' | null = null;
  let voiceVeto = false;

  // Voice veto: a ≥3/5 DIFFERENT-voice panel consensus blocks any MATCH — the
  // voices are not the same person regardless of channel similarity. The
  // verdict becomes UNCERTAIN at minimum, or SUSPICIOUS RELAY when any
  // relay/channel signal also fired (channel vote, integrity flag, relay
  // fingerprint, smear, envelope, probe, conversation).
  if (voicePanel.vetoEngaged && verdict === 'MATCH') {
    const relaySignalFired = votes.some(
      (v) => v.available && v.vote > 0 && v.id !== 'voice',
    );
    verdict = relaySignalFired ? 'SUSPICIOUS RELAY' : 'UNCERTAIN';
    voiceVeto = true;
  }

  if (spectralIntegrity.flags.length > 0 && verdict === 'MATCH') {
    if (voicePanel.overrideEngaged) {
      flagOverride = 'voice_consensus';
    } else {
      verdict = channel.bThinnerThanA ? 'SUSPICIOUS RELAY' : 'UNCERTAIN';
      flagVetoed = true;
    }
  }

  let confidence = Math.round(50 + 50 * Math.min(1, Math.abs(weightedScore)));
  if (reducedConfidence) confidence = Math.max(35, confidence - 15);
  // A same-voice panel consensus that overrode the flag veto is strong
  // identity evidence — boost confidence accordingly.
  if (flagOverride) confidence += 8;
  confidence = Math.min(99, confidence);

  const explanation = buildExplanation({
    baseline,
    voice,
    voicePanel,
    channel,
    spectralIntegrity,
    flagVetoed,
    flagOverride,
    voiceVeto,
    relay: { a: ra, b: rb, voteRelay: relayVoteRelay },
    envelope,
    spectralSmear,
    noiseBed,
    probe,
    conversation,
    verdict,
    relayVotes,
    totalVotes,
    reducedConfidence,
  });

  return {
    baseline,
    timestampIso: new Date().toISOString(),
    a,
    b,
    voice,
    voicePanel,
    channel,
    spectralIntegrity,
    flags: [...spectralIntegrity.flags],
    flagVetoed,
    flagOverride,
    voiceVeto,
    relay: { a: ra, b: rb, voteRelay: relayVoteRelay },
    envelope,
    spectralSmear,
    noiseBed,
    probe,
    conversation,
    votes,
    weightedScore,
    maxWeightedScore: 1,
    verdict,
    confidence,
    relayVotes,
    totalVotes,
    explanation,
    reducedConfidence,
  };
}

// ------------------------------------------------------------- explanation --

interface ExplInput {
  baseline: BaselineMode;
  voice: VoiceSignal;
  voicePanel: VoicePanel;
  channel: ChannelSignal;
  spectralIntegrity: SpectralIntegritySignal;
  flagVetoed: boolean;
  flagOverride: 'voice_consensus' | null;
  voiceVeto: boolean;
  relay: { a: RelayFingerprint; b: RelayFingerprint; voteRelay: boolean };
  envelope: EnvelopeSignal;
  spectralSmear: SmearSignal;
  noiseBed: NoiseSignal;
  probe: ProbeSignal;
  conversation: ConversationSignal;
  verdict: Verdict;
  relayVotes: number;
  totalVotes: number;
  reducedConfidence: boolean;
}

function buildExplanation(x: ExplInput): string {
  const parts: string[] = [];

  // Voice veto / voice-consensus override lead the explanation when engaged.
  if (x.voiceVeto) {
    parts.push(
      `The voices are not the same person (${x.voicePanel.agreeCount}/5 matchers agree DIFFERENT) — this blocks any MATCH regardless of channel similarity.`,
    );
  } else if (x.flagOverride === 'voice_consensus') {
    parts.push(
      `All-quality override: ${x.voicePanel.agreeCount}/5 voice biometric matchers agree this is the same voice — quality flags noted but not blocking.`,
    );
  }

  // Voice
  if (x.voice.gatedSegments >= 1) {
    const sameSpeaker = x.voice.mfccCosine >= 0.62;
    parts.push(
      `Speech-isolated voice match scored ${fmt2(x.voice.mfccCosine)} (MFCC cosine over ${x.voice.gatedSegments} gated segments), ` +
        (sameSpeaker
          ? 'so both clips plausibly carry the same speaker.'
          : 'which leaves speaker identity open.'),
    );
    if (Number.isFinite(x.voice.f0SemitoneDistance)) {
      parts.push(
        `Median F0 sits at ${fmtHz(x.voice.f0A.medianHz)} for A (${x.voice.f0A.pitchClass}) and ${fmtHz(x.voice.f0B.medianHz)} for B (${x.voice.f0B.pitchClass}), a ${x.voice.f0SemitoneDistance.toFixed(1)}-semitone distance.`,
      );
    }
  } else {
    parts.push('Too little gated speech was found for a reliable voice match.');
  }

  // Voice panel — 5-matcher consensus summary
  {
    const vp = x.voicePanel;
    const tally = `${vp.sameCount} same · ${vp.differentCount} different · ${vp.abstainCount} abstain`;
    if (vp.consensus === 'same') {
      parts.push(
        `The calibrated 5-matcher voice panel (MFCC + deltas, Fisher discriminant, root-based formants, pitch/F0, long-term spectrum) reaches a ${vp.agreeCount}/5 SAME-VOICE consensus (${tally}) — speaker identity holds regardless of channel quality.`,
      );
    } else if (vp.consensus === 'different') {
      parts.push(
        `The calibrated 5-matcher voice panel reaches a ${vp.agreeCount}/5 DIFFERENT-VOICE consensus (${tally}) — the two clips carry different speakers, so no MATCH is possible.`,
      );
    } else {
      parts.push(
        `The 5-matcher voice panel has no consensus (${tally}) — speaker identity stays open.`,
      );
    }
  }

  // Channel
  const baseName = x.baseline.charAt(0).toUpperCase() + x.baseline.slice(1);
  if (x.channel.bThinnerThanA) {
    parts.push(
      `B is measurably thinner than A even after normalizing to the ${baseName} baseline: B's spectral centroid sits at ${fmtHz(x.channel.centroidB)} against A's ${fmtHz(x.channel.centroidA)}, with ${fmtPct(x.channel.inbandB)} of B's energy inside the 300–3400 Hz band versus ${fmtPct(x.channel.inbandA)} for A — a thinness delta of ${x.channel.delta.toFixed(2)}, past the ${x.channel.margin.toFixed(2)} margin.`,
    );
  } else {
    parts.push(
      `After normalizing to the ${baseName} baseline, B is not measurably thinner than A: B holds ${fmtPct(x.channel.inbandB)} of its energy in-band versus A's ${fmtPct(x.channel.inbandA)} (delta ${x.channel.delta.toFixed(2)} against a ${x.channel.margin.toFixed(2)} margin), with centroids at ${fmtHz(x.channel.centroidB)} and ${fmtHz(x.channel.centroidA)} respectively.`,
    );
  }

  // Spectral integrity — strict bass/thinness flags on speech frames
  const si = x.spectralIntegrity;
  if (!si.available) {
    parts.push(
      `The strict spectral-integrity check could not run: ${si.detail}.`,
    );
  } else if (si.flags.length > 0) {
    parts.push(`On VAD-gated speech frames, ${si.detail}.`);
    parts.push(
      'A depleted low end or narrowed speech bandwidth is a primary speakerphone-relay symptom, so this flag can never pass silently.',
    );
  } else {
    parts.push(`On VAD-gated speech frames the strict integrity check is clean: ${si.detail}.`);
  }
  if (x.flagVetoed) {
    parts.push(
      `FLAG VETO: the integrity flag blocks a clean MATCH — the verdict is escalated to ${x.verdict}.`,
    );
  } else if (x.flagOverride === 'voice_consensus' && si.flags.length > 0) {
    parts.push(
      `The integrity flags above are informational only: the ${x.voicePanel.agreeCount}/5 same-voice consensus overrides the flag veto (voice identity, not fidelity, decides MATCH here).`,
    );
  }

  // Relay fingerprint
  parts.push(
    `The relay detector flags B at ${fmt2(x.relay.b.score)} (${x.relay.b.state}) versus A at ${fmt2(x.relay.a.score)} (${x.relay.a.state}).`,
  );

  // Envelope
  if (x.envelope.available) {
    const cv = Number.isFinite(x.envelope.burstCVB) ? `burst CV ${fmt2(x.envelope.burstCVB)}` : 'burst CV n/a';
    parts.push(
      `B's envelope is ${x.envelope.gapDepthB > x.envelope.gapDepthA + 2 ? 'compressed' : 'broadly comparable'} (${cv}, gap depth ${fmtDb(x.envelope.gapDepthB)} vs A's ${fmtDb(x.envelope.gapDepthA)}, duty ${fmtPct(x.envelope.dutyB)} vs ${fmtPct(x.envelope.dutyA)}).`,
    );
    if (x.envelope.dutyGated) {
      parts.push(
        'The duty-cycle vote was gated out: the noise bed is very_noisy and the duty cue is unreliable in noise (its sign flips), so it abstains.',
      );
    }
  } else {
    parts.push('Envelope dynamics are unavailable — fewer than 2 speech bursts in at least one clip.');
  }

  // Noise bed — with the speech-to-bed margin against the field anchors
  const marginNote = Number.isFinite(x.noiseBed.b.speechToBedDb)
    ? ` B's speech-to-bed margin is ${fmtDb(x.noiseBed.b.speechToBedDb)} (≈ 8.5 dB = speakerphone drowning in a noisy room; a bed crushed toward −67 dBFS = direct).`
    : '';
  parts.push(
    `B's noise bed reads ${fmtDb(x.noiseBed.b.bedDb)} (SNR ${fmtDb(x.noiseBed.b.snrDb)}, ${x.noiseBed.b.label.replace('_', ' ')}) against A's ${fmtDb(x.noiseBed.a.bedDb)} (SNR ${fmtDb(x.noiseBed.a.snrDb)}, ${x.noiseBed.a.label.replace('_', ' ')}).${marginNote}`,
  );

  // Probe (only when a clip was recorded under challenge noise)
  const pb = x.probe.b;
  if (pb) {
    if (Number.isFinite(pb.fidelity)) {
      const reading =
        pb.fidelity < 0.5
          ? 'the probe arrived smeared, consistent with a room relay'
          : pb.fidelity >= 0.75
            ? 'the probe arrived intact, consistent with a direct path'
            : 'the probe response is ambiguous';
      parts.push(
        `B was recorded under challenge noise; probe response fidelity ${fmt2(pb.fidelity)} (${pb.fidelityState}) — ${reading}.`,
      );
    } else {
      parts.push(
        'B was recorded under challenge noise, but too little probe-dominant audio was captured to score the probe response.',
      );
    }
  } else if (x.probe.a) {
    parts.push('A was recorded under challenge noise; the probe cue is scored on B, so it informs context only.');
  }

  // Conversation
  if (Number.isFinite(x.conversation.spectrumCorrelation)) {
    parts.push(
      x.conversation.sharedContentLikely
        ? `The conversation cue agrees (long-term spectrum correlation ${fmt2(x.conversation.spectrumCorrelation)}).`
        : `The conversation cue is inconclusive (long-term spectrum correlation ${fmt2(x.conversation.spectrumCorrelation)}).`,
    );
  }

  // Tally
  if (x.verdict === 'SUSPICIOUS RELAY') {
    parts.push(`${x.relayVotes} of ${x.totalVotes} weighted votes point at a second-hop relay.`);
  } else if (x.verdict === 'MATCH') {
    parts.push(`${x.totalVotes - x.relayVotes} of ${x.totalVotes} weighted votes are consistent with A's channel.`);
  } else {
    parts.push(`Only ${x.relayVotes} of ${x.totalVotes} weighted votes point at a relay — the signals disagree.`);
  }

  if (x.reducedConfidence) {
    parts.push('Confidence is reduced: at least one clip is very short or has too few speech bursts.');
  }

  return parts.join(' ');
}
