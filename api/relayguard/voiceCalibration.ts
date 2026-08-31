// voiceCalibration.ts — shipped calibration constants for the 5-matcher voice panel.
// Trained offline against the VoxForge corpus (32 male speakers, F0 < 160 Hz filter)
// plus the user's field sample, on channel-normalized (okay baseline) audio,
// mixed clean/relay calibration pairs. No network calls at runtime — these
// constants are the entire learned state of the panel.
//
// Source: voice-calibration.json (version 2).

export interface LogisticParams {
  /** slope */
  a: number;
  /** intercept */
  b: number;
}

/** 13 MFCC + deltas, speech-gated; 24-dim [mean(c1..c12), 0.5*std(c1..c12)]; cosine of mean-centered vectors */
export const MFCC_V2_LOGISTIC: LogisticParams = { a: 10.764379839594824, b: -9.525213303714839 };

/** Fisher-weighted Euclidean distance on same 24-dim vector (weights trained between/within speaker variance); raw = -distance */
export const FISHER_LOGISTIC: LogisticParams = { a: 1.34161909263073, b: 3.6021570865635257 };

/** LPC order 12 root-based F1/F2/F3 medians on voiced frames; score = mean over formants of clip(1 - relDelta/0.18) */
export const FORMANT_LOGISTIC: LogisticParams = { a: 3.3554950807691224, b: -1.8301498578363042 };

/** autocorrelation F0 median on voiced frames; score = exp(-|semitoneDiff|/3.5) */
export const F0_LOGISTIC: LogisticParams = { a: 2.8791224546807683, b: -1.8186351195085813 };

/** 24 log-spaced bands 200-3600 Hz long-term average spectrum (speech frames), mean-normalized dB; cosine */
export const LTAS_LOGISTIC: LogisticParams = { a: 8.421114663696368, b: -7.23405216772594 };

/** Corpus-trained Fisher discriminant weights (50 dims: 25 means + 25 half-stds of the
 * MFCC+delta long-term vector). between/within-speaker variance ratios, normalized. */
export const FISHER_WEIGHTS: readonly number[] = [
  0.5882615197978234, 0.3064038988603103, 0.20303502529078482, 0.1669787028572331, 0.11284465062486045, 0.29106048737461326, 0.9999999999998278, 0.8951011140006454, 0.5229149212803953, 0.40154294125560774,
  0.57917389648737, 0.42921378470065696, 0.04544034515004375, 0.06746868661208902, 0.057257353998905025, 0.04420340051279587, 0.046399121348950655, 0.04515086779868568, 0.03750530825329437, 0.028739596449255087,
  0.054610351555555665, 0.035660811520275774, 0.041240433217386206, 0.03624703244011219, 0.03025139161587135, 0.24258030592945634, 0.29036375439829515, 0.10511452448313731, 0.14188120207565064, 0.15820909829385746,
  0.14981758848343318, 0.16018483420948726, 0.14706426622892524, 0.17815280220475221, 0.2825367478025788, 0.20102568792039677, 0.17396765163309547, 0.35724507993920995, 0.20776351928579018, 0.21367133486527362,
  0.11038921416119817, 0.19621204547921434, 0.17836674973054695, 0.1714712033131119, 0.18919098628241293, 0.1588350290680703, 0.11627763314860297, 0.26684739827191883, 0.12411375115671007, 0.11789084564529285,
];

/** Calibrated-probability vote thresholds: p >= same -> SAME vote, p <= different -> DIFFERENT. */
export const VOTE_SAME_AT = 0.6;
export const VOTE_DIFFERENT_AT = 0.4;

/** Held-out panel metrics from the calibration run (reused in UI + methodology copy). */
export const CALIBRATION = {
  trainedOn: "VoxForge 32 male speakers (71 speakers sampled, F0<160Hz male filter) + user voice; channel-normalized (okay baseline) mixed clean/relay calibration",
  voices: 33,
  clean: {
    samePairs: { same: 96, noConsensus: 83, different: 1 },
    diffPairs: { different: 266, noConsensus: 230, same: 4 },
    falseSameRate: 0.008,
  },
  relay: {
    samePairs: { same: 5, noConsensus: 30, different: 1 },
    diffPairs: { different: 197, noConsensus: 106, same: 0 },
    falseSameRate: 0.0,
  },
  userVs32Males: { different: 25, noConsensus: 7, same: 0 },
} as const;

/** Short analyst-facing note shown under the voice panel. */
export const CALIBRATION_NOTE =
  'Matchers calibrated on 33 male voices (VoxForge corpus + field sample) — held-out false-same rate 0.8%.';
