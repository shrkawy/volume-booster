# Chrome Web Store publishing

## First publication

1. Finish [Chrome Web Store developer registration](https://chrome.google.com/webstore/devconsole). Google currently charges a one-time $5 fee.
2. Run `python scripts/package.py` with Node.js 24 and Python 3.12 installed. Upload the ZIP from `dist/` as a new item. The manifest is at the ZIP root.
3. Use `store/listing.md` for the description and permission explanations. Add actual extension screenshots, the existing 128px icon, and the required store artwork.
4. Use the public GitHub URL for `PRIVACY.md` as the privacy policy URL. Review the dashboard's privacy declarations against that policy.
5. Complete publisher contact verification, any required account checks, distribution settings, and submit for review.
6. Record the publisher ID and the item's extension ID. Google must approve the first listing.

## Connect GitHub releases

The workflow is installed, but publishing cannot run until the store item and credentials exist.

Follow Google's [service account setup](https://developer.chrome.com/docs/webstore/service-accounts):

1. Enable the Chrome Web Store API in a Google Cloud project.
2. Create a service account and link its email in the Chrome Web Store Developer Dashboard's Account section. It does not need a Google Cloud project role to use the store API.
3. Create a JSON key for that service account. In this repository's Settings > Secrets and variables > Actions, save the entire JSON as the secret `CWS_SERVICE_ACCOUNT_KEY`. Never commit it.
4. Add repository variables `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID` with the IDs from the store dashboard.

Each publisher currently supports one linked service account. Both repositories can use that same account, with different extension IDs.

## Release an update

1. Increase `version` in `manifest.json` and push the change to `main`.
2. Create a GitHub release from that commit with the tag `v<manifest version>`.
3. Publishing a stable release builds and validates the ZIP, keeps it as a workflow artifact, then uploads and submits it for Chrome Web Store review.

Pushes and pull requests validate and package only. Prereleases do not publish. A release tag that differs from the manifest version fails before upload. Chrome rejects versions that have already been uploaded.

For a manual submission of the current `main` version, run the workflow with `publish` selected. Leave it unselected to build only.

The Web Store has no direct GitHub repository sync. This workflow uses the [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api). Google's review still applies to every update; the workflow cannot guarantee immediate availability. Chrome then distributes approved versions through its normal extension update mechanism.

## Credentials

The publishing script uses Node's built-in cryptography and fetch APIs. It exchanges a signed service account JWT for a short-lived access token and does not write credentials to disk or print token responses. The JSON key remains a long-lived GitHub secret; revoke and replace it if compromised.

