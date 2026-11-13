# Chrome Web Store listing draft

Name: Clean Volume Booster

Version: 1.1.0

Summary: Boost tab volume up to 250% with a look-ahead limiter and per-tab controls.

Suggested category: Tools

Language: English

Website: https://github.com/shrkawy/volume-booster

Support: https://github.com/shrkawy/volume-booster/issues

Privacy policy: https://github.com/shrkawy/volume-booster/blob/main/PRIVACY.md

## Description

Make quiet browser audio louder with a separate volume control for each tab.

Clean Volume Booster raises tab volume from 100% to 250%. A look-ahead limiter reduces peaks to help avoid clipping, and a gentle compressor manages louder passages.

- Adjust volume with the dial, presets, mouse wheel, or keyboard.
- Keep a different boost level on each active tab.
- See a live meter showing limiter activity.
- Optionally filter low-frequency rumble.
- Use light or dark themes and keyboard-accessible controls.

Click the extension icon on a tab containing audio or video to start. Audio is processed inside your browser and is not recorded or uploaded.

Requires Chrome 116 or later. Keep listening volume at a comfortable level.

## Single purpose

Raise the volume of user-selected browser tabs with local audio processing and peak limiting.

## Permission explanations

- tabCapture: capture audio from the tab the user explicitly chooses to boost.
- offscreen: keep the Web Audio processing graph running while the popup is closed.
- storage: remember boost and filter preferences, and hold active-tab state.
- activeTab: access the user-selected tab after an extension click and display its title and icon.
- scripting: check the selected page and its frames for audio and video elements before enabling boost controls.

## Privacy declarations to review in the dashboard

The extension uses tab audio and current-page information only to provide its stated purpose. It has no remote code, analytics, advertising, or data upload. Read PRIVACY.md before completing Google's data-use certifications.

## Assets still required

Use icons/icon128.png for the store icon. Capture genuine screenshots of the extension operating in Chrome. Add the promotional artwork required by the dashboard. Do not upload this Markdown file inside the extension ZIP.

