# Clean Volume Booster

A Chrome extension that makes any tab up to 250% louder without clipping, distortion or strain on your speakers.

Most volume boosters multiply the audio and let it clip: the tops of the waveform get cut off flat. That clipping is the harsh, crackly sound you hear, and it pushes extra high-frequency energy into tweeters. This extension never clips. A look-ahead limiter lowers the level just before a peak arrives, so the output always stays below -1 dBFS.

## Features

- Boost from 100% to 250% with a dial, presets, the mouse wheel or the keyboard
- Look-ahead limiter: the output never goes above -1 dBFS
- Gentle compressor that only touches the loudest moments, and only as much as the boost needs
- Optional speaker protection that removes sub-30 Hz rumble small speakers can't play
- Live meter showing how hard the limiter is working
- Per-tab: each tab keeps its own boost level
- Light and dark themes, full keyboard and screen-reader support
- Lightweight: no frameworks or libraries, about 0.1% of one CPU core during normal playback

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Pin the extension, open a tab that's playing sound, click the icon and turn the dial.

Requires Chrome 116 or newer. It also works in other Chromium browsers that support the `tabCapture` and `offscreen` APIs.

## How it works

```
tab audio -> high-pass filter -> boost -> compressor -> look-ahead limiter -> speakers
```

| File | Role |
| --- | --- |
| `popup.html/css/js` | The dial UI |
| `background.js` | Tracks which tabs are boosted and manages the audio engine |
| `offscreen.html/js` | Captures tab audio and builds the Web Audio graph |
| `booster-worklet.js` | The DSP: smoothed gain, soft-knee compressor, look-ahead limiter |

**Boost.** Gain changes glide over 30 ms, so moving the dial never clicks.

**Compressor.** 2:1 ratio with a 6 dB soft knee. Its threshold follows the boost level, so at 100% it does almost nothing. A 25 ms hold keeps the gain steady through bass waves, which prevents distortion on low notes.

**Limiter.** Audio is delayed 5 ms. During that time the required gain reduction is found with a sliding-window minimum, then smoothed with a moving average of the same length. Because of this, the gain has fully settled by the time a peak leaves the delay line, so the output can't overshoot the ceiling. Left and right are processed together, so the stereo image never shifts.

**Speaker protection.** A 2nd-order Butterworth high-pass at 30 Hz. Turned off, it moves to 10 Hz and only blocks DC.

The audio engine only exists while a tab is boosted. Chrome closes it when you stop, and the meter only runs while the popup is open.

## Tests

The DSP can be tested offline with Node.js:

```bash
node test/dsp-test.js
```

The test checks that the output never exceeds the ceiling (including on a sudden full-scale burst), that 100% boost is bit-for-bit transparent, that distortion stays at 0% while limiting, and that the stereo image is preserved.

## Permissions

- `tabCapture`: read the audio of the tab you choose to boost
- `offscreen`: run the audio engine in the background
- `storage`: remember your boost level and settings
- `activeTab`: show the current tab's title and icon in the popup

No data leaves your browser.

## License

MIT. See [LICENSE](LICENSE).
