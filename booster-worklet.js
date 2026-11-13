// Audio processing for Clean Volume Booster.
//
// Signal chain (all stereo-linked so the stereo image never shifts):
//   1. Smoothed gain        - the boost itself, ramped so slider moves never click.
//   2. Gentle compressor    - soft knee, 2:1, slow release. Only touches the loudest
//                             passages, and its threshold follows the boost amount, so
//                             at 100% it does almost nothing.
//   3. Look-ahead limiter   - brick-wall ceiling at -1 dBFS. The gain reduction starts
//                             before a peak arrives, so the waveform is never clipped.
//                             Clipping (square-wave distortion) is what makes cheap
//                             boosters sound harsh and what overheats speaker tweeters.

const CEILING_DB = -1.0;
const LOOKAHEAD_S = 0.005;   // 5 ms: time the limiter has to fade gain down before a peak
const LIM_HOLD_S = 0.010;    // hold the reduction 10 ms so bass waves are not modulated
const LIM_RELEASE_S = 0.120; // then recover smoothly
const COMP_RATIO = 2.0;
const COMP_KNEE_DB = 6.0;
const COMP_ATTACK_S = 0.010;
const COMP_HOLD_S = 0.025;   // longer than half a period of 25 Hz: no ripple on bass
const COMP_RELEASE_S = 0.250;
const GAIN_SMOOTH_S = 0.030;

const dbToLin = (db) => Math.pow(10, db / 20);
const LN10_OVER_20 = Math.LN10 / 20;
const TWENTY_OVER_LN10 = 20 / Math.LN10;

// The compressor threshold moves down as the boost goes up, so the compressor
// only starts working once the boost would otherwise push audio into the limiter.
function thresholdForBoost(boost) {
  const boostDb = 20 * Math.log10(Math.max(1, boost));
  return CEILING_DB - 1 - 1.25 * boostDb;
}

class CleanBoosterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const sr = sampleRate;

    this.ceiling = dbToLin(CEILING_DB);

    // Gain: start at unity and glide to the requested boost.
    this.gain = 1;
    this.targetGain = 1;
    this.gainCoef = 1 - Math.exp(-1 / (GAIN_SMOOTH_S * sr));

    // Compressor state.
    this.threshold = thresholdForBoost(1);
    this.compEnv = 0;
    this.compHold = 0;
    this.compHoldSamples = Math.round(COMP_HOLD_S * sr);
    this.compAtt = Math.exp(-1 / (COMP_ATTACK_S * sr));
    this.compRel = Math.exp(-1 / (COMP_RELEASE_S * sr));

    // Limiter: delay line of D samples. Gain = moving average (length D+1) of a
    // released sliding minimum (window W >= D+1) of the required gain. That
    // combination guarantees the gain has fully settled when the peak leaves
    // the delay line, so output never exceeds the ceiling.
    this.D = Math.max(1, Math.round(LOOKAHEAD_S * sr));
    this.L = this.D + 1;
    this.W = this.L + Math.round(LIM_HOLD_S * sr);

    this.delayL = new Float32Array(this.D);
    this.delayR = new Float32Array(this.D);
    this.delayIdx = 0;

    // Monotonic deque for the sliding minimum (power-of-two ring, so indexing is a bit mask).
    let cap = 1;
    while (cap < this.W + 2) cap <<= 1;
    this.dqMask = cap - 1;
    this.dqVal = new Float64Array(cap);
    this.dqTime = new Float64Array(cap);
    this.dqHead = 0;
    this.dqSize = 0;
    this.t = 0;

    this.limEnv = 1;
    this.limRelCoef = 1 - Math.exp(-1 / (LIM_RELEASE_S * sr));

    this.box = new Float64Array(this.L).fill(1);
    this.boxSum = this.L;
    this.boxIdx = 0;

    // Metering is pull-based: stats accumulate cheaply and are only sent when
    // the popup asks, so nothing is posted while the popup is closed.
    this.meterMinGain = 1;
    this.meterPeak = 0;
    this.meterRequested = false;

    this.setBoost(typeof opts.boost === 'number' ? opts.boost : 1.5);

    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (typeof msg.boost === 'number') this.setBoost(msg.boost);
      if (msg.poll) this.meterRequested = true;
    };
  }

  setBoost(boost) {
    const b = Math.min(4, Math.max(1, boost));
    this.targetGain = b;
    this.threshold = thresholdForBoost(b);
    // Below the knee the compressor does nothing, so skip its log/exp math there.
    this.kneeStartLin = dbToLin(this.threshold - COMP_KNEE_DB / 2);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const n = outL.length;

    const hasInput = input && input.length > 0;
    const inL = hasInput ? input[0] : null;
    const inR = hasInput ? (input[1] || input[0]) : null;

    // Hot state copied into locals: much faster than touching `this` per sample.
    const ceiling = this.ceiling;
    const T = this.threshold;
    const K = COMP_KNEE_DB;
    const halfK = K / 2;
    const slope = 1 / COMP_RATIO - 1;
    const compAtt = this.compAtt;
    const compRel = this.compRel;
    const holdN = this.compHoldSamples;
    const kneeLin = this.kneeStartLin;
    const tg = this.targetGain;
    const gc = this.gainCoef;
    const lrc = this.limRelCoef;
    const D = this.D;
    const L = this.L;
    const W = this.W;
    const box = this.box;
    const dL = this.delayL;
    const dR = this.delayR;
    const dqV = this.dqVal;
    const dqT = this.dqTime;
    const mask = this.dqMask;

    let gain = this.gain;
    let env = this.compEnv;
    let hold = this.compHold;
    let limEnv = this.limEnv;
    let boxSum = this.boxSum;
    let bi = this.boxIdx;
    let di = this.delayIdx;
    let head = this.dqHead;
    let size = this.dqSize;
    let t = this.t;
    let mMin = this.meterMinGain;
    let mPeak = this.meterPeak;

    for (let i = 0; i < n; i++) {
      // 1. Boost (smoothed, snaps once it arrives).
      if (gain !== tg) {
        gain += (tg - gain) * gc;
        if (Math.abs(tg - gain) < 1e-7) gain = tg;
      }
      let l = hasInput ? inL[i] * gain : 0;
      let r = hasInput ? inR[i] * gain : 0;

      // 2. Gentle compressor: peak detector with hold, soft knee.
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const peakIn = al > ar ? al : ar;
      if (peakIn >= env) {
        env = peakIn + compAtt * (env - peakIn);
        hold = holdN;
      } else if (hold > 0) {
        hold--;
      } else {
        env = peakIn + compRel * (env - peakIn);
      }

      let compGain = 1;
      if (env > kneeLin) {
        const over = Math.log(env) * TWENTY_OVER_LN10 - T;
        let grDb;
        if (over >= halfK) {
          grDb = slope * over;
        } else {
          const k = over + halfK;
          grDb = (slope * k * k) / (2 * K);
        }
        compGain = Math.exp(grDb * LN10_OVER_20);
        l *= compGain;
        r *= compGain;
      }

      // 3. Look-ahead limiter.
      const bl = l < 0 ? -l : l;
      const br = r < 0 ? -r : r;
      const peak = bl > br ? bl : br;
      const req = peak > ceiling ? ceiling / peak : 1;

      // Sliding minimum of the required gain over the last W samples.
      while (size > 0 && dqV[(head + size - 1) & mask] >= req) size--;
      const pos = (head + size) & mask;
      dqV[pos] = req;
      dqT[pos] = t;
      size++;
      while (dqT[head] <= t - W) {
        head = (head + 1) & mask;
        size--;
      }
      t++;
      const m = dqV[head];

      limEnv = m < limEnv ? m : limEnv + (m - limEnv) * lrc;

      boxSum += limEnv - box[bi];
      box[bi] = limEnv;
      if (++bi === L) bi = 0;
      let limGain = boxSum / L;
      if (limGain > 1) limGain = 1;

      const xl = dL[di];
      const xr = dR[di];
      dL[di] = l;
      dR[di] = r;
      if (++di === D) di = 0;

      let ol = xl * limGain;
      let or = xr * limGain;
      // Safety net against floating-point drift only; the limiter keeps
      // signals below this, so in practice it never engages.
      if (ol > ceiling) ol = ceiling; else if (ol < -ceiling) ol = -ceiling;
      if (or > ceiling) or = ceiling; else if (or < -ceiling) or = -ceiling;
      outL[i] = ol;
      if (outR !== outL) outR[i] = or;

      // Metering (cheap running min/max).
      const total = compGain * limGain;
      if (total < mMin) mMin = total;
      const aol = ol < 0 ? -ol : ol;
      const aor = or < 0 ? -or : or;
      if (aol > mPeak) mPeak = aol;
      if (aor > mPeak) mPeak = aor;
    }

    this.gain = gain;
    this.compEnv = env;
    this.compHold = hold;
    this.limEnv = limEnv;
    this.boxIdx = bi;
    this.delayIdx = di;
    this.dqHead = head;
    this.dqSize = size;
    this.t = t;

    // Re-sum the moving average now and then to stop rounding drift.
    if ((t & 0xffff) < n) {
      boxSum = 0;
      for (let j = 0; j < L; j++) boxSum += box[j];
    }
    this.boxSum = boxSum;

    if (this.meterRequested) {
      this.port.postMessage({
        reductionDb: -20 * Math.log10(Math.max(mMin, 1e-6)),
        peakDb: 20 * Math.log10(Math.max(mPeak, 1e-6)),
      });
      this.meterRequested = false;
      mMin = 1;
      mPeak = 0;
    }
    this.meterMinGain = mMin;
    this.meterPeak = mPeak;

    return true;
  }
}

registerProcessor('clean-booster', CleanBoosterProcessor);
