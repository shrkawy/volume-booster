// Offline test of booster-worklet.js. Run: node test/dsp-test.js
// and checks peaks, transparency and harmonic distortion.
const fs = require('fs');
const vm = require('vm');

const SR = 48000;
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'booster-worklet.js'), 'utf8');
let Proc;
const sandbox = {
  sampleRate: SR,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
  registerProcessor: (_n, c) => { Proc = c; },
  Math, Float32Array, Float64Array,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

function run(boost, genL, genR, seconds) {
  const p = new Proc({ processorOptions: { boost } });
  const N = Math.round(seconds * SR);
  const outL = new Float32Array(N), outR = new Float32Array(N);
  const inL = new Float32Array(N), inR = new Float32Array(N);
  for (let i = 0; i < N; i++) { inL[i] = genL(i); inR[i] = genR ? genR(i) : inL[i]; }
  for (let off = 0; off < N; off += 128) {
    const n = Math.min(128, N - off);
    const a = [inL.subarray(off, off + n), inR.subarray(off, off + n)];
    const o = [new Float32Array(n), new Float32Array(n)];
    p.process([a], [o]);
    outL.set(o[0], off); outR.set(o[1], off);
  }
  return { inL, inR, outL, outR, D: p.D };
}

const peak = (a, from = 0) => { let m = 0; for (let i = from; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const db = (x) => (20 * Math.log10(x)).toFixed(2) + ' dB';

// THD via DFT at harmonic bins (window an integer number of cycles).
function thd(sig, f0, from, len) {
  const mag = (k) => {
    let re = 0, im = 0;
    for (let i = 0; i < len; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len); // Hann
      const x = sig[from + i] * w;
      const ph = (2 * Math.PI * k * f0 * i) / SR;
      re += x * Math.cos(ph); im -= x * Math.sin(ph);
    }
    return Math.hypot(re, im);
  };
  const fund = mag(1);
  let h = 0;
  for (let k = 2; k <= 10; k++) { if (k * f0 < SR / 2) h += mag(k) ** 2; }
  return Math.sqrt(h) / fund;
}

const CEIL = Math.pow(10, -1 / 20);
let fail = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); if (!ok) fail++; };

// 1. Full-scale sine, max boost: must never exceed the ceiling.
for (const f of [40, 100, 1000, 8000]) {
  const r = run(2.5, (i) => Math.sin((2 * Math.PI * f * i) / SR), null, 2);
  const pk = peak(r.outL);
  check(`full-scale ${f} Hz @250%`, pk <= CEIL + 1e-6, `peak ${db(pk)} (ceiling -1.00 dB)`);
}

// 2. Sudden full-scale burst after silence (worst case for a limiter).
{
  const r = run(2.5, (i) => (i < SR * 0.5 ? 0 : (i % 2 ? 1 : -1) * 0.99), null, 1);
  const pk = peak(r.outL);
  check('instant full-scale burst @250%', pk <= CEIL + 1e-6, `peak ${db(pk)}`);
}

// 3. Loud random "music-like" signal with transients.
{
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const gen = (i) => {
    const kick = (i % 24000) < 2000 ? Math.sin((2 * Math.PI * 55 * i) / SR) * Math.exp(-(i % 24000) / 3000) : 0;
    return Math.max(-1, Math.min(1, 0.5 * rnd() * 0.6 + 0.9 * kick + 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR)));
  };
  const r = run(2.5, gen, null, 5);
  const pk = Math.max(peak(r.outL), peak(r.outR));
  check('dense signal with kicks @250%', pk <= CEIL + 1e-6, `peak ${db(pk)}`);
}

// 4. Transparency at 100%: moderate signal must pass bit-for-bit (just delayed).
{
  const gen = (i) => 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 97 * i) / SR);
  const r = run(1.0, gen, null, 1);
  let maxErr = 0;
  for (let i = r.D + 1000; i < r.outL.length; i++) maxErr = Math.max(maxErr, Math.abs(r.outL[i] - r.inL[i - r.D]));
  check('100% boost is transparent', maxErr < 1e-6, `max error ${maxErr.toExponential(2)}`);
}

// 5. Quiet audio at 150% gets exactly +3.52 dB, no compression.
{
  const amp = 0.03;
  const r = run(1.5, (i) => amp * Math.sin((2 * Math.PI * 1000 * i) / SR), null, 1);
  const g = peak(r.outL, SR / 2) / amp;
  check('quiet audio gets full 150%', Math.abs(g - 1.5) < 0.005, `gain x${g.toFixed(4)} (${db(g)})`);
}

// 6. Distortion while being pushed hard: steady sines at -1 dBFS, 250% boost.
for (const f of [50, 100, 1000]) {
  const r = run(2.5, (i) => 0.89 * Math.sin((2 * Math.PI * f * i) / SR), null, 3);
  const len = Math.round((SR / f) * Math.floor((SR * 1) / (SR / f)) );
  const cycles = Math.floor(SR / f) * 0 + Math.floor(1 * f);
  const n = Math.round((cycles * SR) / f);
  const t = thd(r.outL, f, SR * 2 - n / 2 | 0, n);
  check(`THD ${f} Hz while limiting @250%`, t < 0.01, `THD ${(t * 100).toFixed(3)}%`);
}

// 7. Stereo image preserved: left-only content stays left-only.
{
  const r = run(2.5, (i) => Math.sin((2 * Math.PI * 300 * i) / SR), () => 0, 1);
  check('stereo image preserved', peak(r.outR) === 0, `right peak ${peak(r.outR)}`);
}

console.log(fail ? `\n${fail} test(s) failed` : '\nAll tests passed');
process.exit(fail ? 1 : 0);
