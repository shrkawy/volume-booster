// Offscreen document: captures tab audio and runs it through the booster.
//
// Chain per tab:
//   tab audio -> sub-bass filter -> booster worklet (gain, compressor, limiter) -> speakers
//
// The sub-bass filter is a gentle 2nd-order Butterworth high-pass. With speaker
// protection on it sits at 30 Hz: content below that is mostly felt rather than
// heard, but boosting it pushes small speaker cones past their travel limit,
// which is where rattling, distortion and damage come from. With protection off
// it drops to 10 Hz and only blocks DC offset.

const PROTECT_HZ = 30;
const UNPROTECTED_HZ = 10;

let ctx = null;
let workletReady = null;
const sessions = new Map(); // tabId -> { stream, source, filter, node, meter }

async function getContext() {
  if (!ctx) {
    // Use the device's native sample rate so nothing gets resampled.
    ctx = new AudioContext({ latencyHint: 'balanced' });
    workletReady = ctx.audioWorklet.addModule('booster-worklet.js');
  }
  await workletReady;
  if (ctx.state !== 'running') await ctx.resume();
  return ctx;
}

function clampBoost(b) {
  return Math.min(2.5, Math.max(1, Number(b) || 1));
}

async function start({ tabId, streamId, boost, protect }) {
  if (sessions.has(tabId)) stop(tabId);

  const ac = await getContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const source = ac.createMediaStreamSource(stream);
  const filter = new BiquadFilterNode(ac, {
    type: 'highpass',
    frequency: protect ? PROTECT_HZ : UNPROTECTED_HZ,
    Q: Math.SQRT1_2,
  });
  const node = new AudioWorkletNode(ac, 'clean-booster', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { boost: clampBoost(boost) },
  });

  const session = { stream, source, filter, node, meter: null };
  node.port.onmessage = (e) => {
    session.meter = e.data;
  };

  source.connect(filter).connect(node).connect(ac.destination);
  sessions.set(tabId, session);

  // Fires if the tab is closed or capture is revoked from Chrome's UI.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (sessions.get(tabId) === session) {
        stop(tabId);
        chrome.runtime.sendMessage({ target: 'background', type: 'captureEnded', tabId }).catch(() => {});
      }
    });
  }
}

function update({ tabId, boost, protect }) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.node.port.postMessage({ boost: clampBoost(boost) });
  // Glide the filter so toggling protection never clicks.
  s.filter.frequency.setTargetAtTime(protect ? PROTECT_HZ : UNPROTECTED_HZ, ctx.currentTime, 0.05);
}

function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  s.node.port.onmessage = null;
  s.source.disconnect();
  s.filter.disconnect();
  s.node.disconnect();
  s.stream.getTracks().forEach((t) => t.stop());
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'start':
      start(msg)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    case 'update':
      update(msg);
      sendResponse({ ok: true });
      return false;
    case 'stop':
      stop(msg.tabId);
      sendResponse({ ok: true });
      return false;
    case 'getMeter': {
      // Reply with the latest reading and ask the worklet for the next one.
      const s = sessions.get(msg.tabId);
      if (s) s.node.port.postMessage({ poll: true });
      sendResponse({ ok: true, meter: s ? s.meter : null });
      return false;
    }
    default:
      return false;
  }
});
