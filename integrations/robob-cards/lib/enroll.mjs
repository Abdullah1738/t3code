import { randomUUID } from "node:crypto";

export const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const UDID = /^[0-9A-Fa-f-]{24,40}$/;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

export function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// iOS posts a CMS-signed blob; the device attributes sit in a plain XML plist
// inside it, so the plist is cut out of the raw bytes instead of verifying CMS.
export function extractDevice(body, token) {
  const text = Buffer.isBuffer(body) ? body.toString("latin1") : String(body);
  const plist = text.match(/<\?xml[\s\S]*?<\/plist>/)?.[0];
  if (!plist) throw new Error("no device plist in the enrollment response");
  const field = (key) => {
    const value = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
    return value === undefined ? undefined : Buffer.from(unescapeXml(value), "latin1").toString("utf8");
  };
  const challenge = field("CHALLENGE");
  if (challenge !== undefined && challenge !== token) throw new Error("enrollment challenge does not match");
  const udid = field("UDID");
  if (!udid || !UDID.test(udid)) throw new Error("enrollment response has no valid UDID");
  return {
    udid,
    product: field("PRODUCT") ?? null,
    osVersion: field("VERSION") ?? null,
    deviceName: field("DEVICE_NAME") ?? null,
  };
}

export function profileServiceConfig({ callbackUrl, token }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${escapeXml(callbackUrl)}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>PRODUCT</string>
      <string>VERSION</string>
      <string>DEVICE_NAME</string>
    </array>
    <key>Challenge</key>
    <string>${escapeXml(token)}</string>
  </dict>
  <key>PayloadOrganization</key>
  <string>Robob</string>
  <key>PayloadDisplayName</key>
  <string>Robob Cards registration</string>
  <key>PayloadDescription</key>
  <string>Shares this iPhone's device ID so Robob Cards can be installed on it. Nothing stays installed.</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadUUID</key>
  <string>${randomUUID().toUpperCase()}</string>
  <key>PayloadIdentifier</key>
  <string>com.abdullah.robob.cards.enroll</string>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>
`;
}

export function manifestPlist({ ipaUrl, iconUrl, bundleId, version, title }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeXml(ipaUrl)}</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>display-image</string>
          <key>url</key>
          <string>${escapeXml(iconUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(bundleId)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

// One copy of the instructions, so the page and the text an agent sends match.
export const STEPS = {
  register: [
    "Tap Register this iPhone, then tap Allow.",
    "Open Settings and tap Profile Downloaded near the top. Tap Install, enter your passcode, then tap Install again if asked. It may say Not Verified; that's fine.",
    "Safari comes back by itself (if not, open Safari again). In a minute or two this page shows an Install button.",
  ],
  install: [
    "Tap Install, then tap Install in the pop-up.",
    "Wait for Robob Cards to finish loading on your Home Screen, then open it once.",
    "If it says Developer Mode Required, tap OK. Open Settings, tap Privacy & Security, scroll down to Developer Mode, turn it on and tap Restart. After the restart, unlock your iPhone, tap Turn On (it may say Enable) and enter your passcode. Then open Robob Cards again.",
    "When it says Robob Cards is installed, you're done. Robob's cards now open right inside your Messages chat. To find the app, open any chat, tap + next to the message box, then More.",
  ],
};

export function stepsText(link) {
  return [
    "Here's how to get Robob Cards on your iPhone. It takes about five minutes.",
    "",
    `1. Open this link in Safari on your iPhone: ${link}`,
    `2. Tap "Register this iPhone", then tap Allow.`,
    `3. Open Settings and tap "Profile Downloaded" near the top. Tap Install, enter your passcode, then tap Install again if asked. It may say "Not Verified"; that's fine.`,
    "4. Safari comes back by itself (if not, open Safari again). In a minute or two the page shows an Install button. Tap it, then tap Install in the pop-up.",
    "5. Wait for Robob Cards to finish loading on your Home Screen, then open it once.",
    `6. If it says "Developer Mode Required", tap OK. Open Settings > Privacy & Security, scroll down to Developer Mode, turn it on and tap Restart. After the restart, unlock your iPhone, tap Turn On (it may say Enable) and enter your passcode. Then open Robob Cards again.`,
    `7. When it says "Robob Cards is installed", you're done. Robob's cards now open right inside Messages. To find the app, open any chat, tap + next to the message box, then More.`,
  ].join("\n");
}

const STYLE = `
:root{color-scheme:light dark;--ground:#f1f5f1;--ink:#16201a;--soft:#46524b;--accent:#1c6a4b;--on-accent:#ffffff;--field:#e1eae3}
@media (prefers-color-scheme:dark){:root{--ground:#111613;--ink:#edf3ef;--soft:#b5c1ba;--accent:#82d4aa;--on-accent:#0b1a12;--field:#1c2520}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:18px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:34rem;margin:0 auto;padding:40px 24px 56px}
.mark{display:block;width:88px;height:88px;border-radius:20px}
h1{font-size:40px;line-height:1.05;letter-spacing:-0.03em;margin:28px 0 12px}
p{margin:0 0 24px}
.action{display:block;margin:8px 0 32px;padding:18px 24px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-size:20px;font-weight:600;text-align:center;text-decoration:none}
.action:active{opacity:.85}
ol{margin:0 0 24px;padding:24px 24px 24px 48px;border-radius:20px;background:var(--field)}
li{margin:0 0 12px;padding-left:4px}
li:last-child{margin:0}
.note{color:var(--soft);font-size:16px}
`;

function layout({ title, body, refreshSeconds }) {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
${refresh}
<title>${escapeXml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<img class="mark" src="icon.png" alt="Robob Cards icon" width="88" height="88">
${body}
</main>
</body>
</html>
`;
}

const list = (items) => `<ol>${items.map((item) => `<li>${escapeXml(item)}</li>`).join("")}</ol>`;

// Relative links keep the page working whatever public host the tunnel got,
// so each page lives at /c/<token>/ and its assets beside it.
export function enrollPage({ phase, manifestUrl, pendingDevice }) {
  if (phase === "preparing") {
    if (pendingDevice?.status === "PROCESSING") {
      return layout({
        title: "Waiting for Apple",
        refreshSeconds: 60,
        body: `<h1>Waiting for Apple</h1>
<p>Your iPhone is registered. Apple is still approving it, which can take 24–72 hours.</p>
<p class="note">No need to register again. Come back to this page for Install once the app is ready.</p>`,
      });
    }
    return layout({
      title: "Almost there",
      refreshSeconds: 10,
      body: `<h1>Almost there</h1>
<p>Your iPhone is registered. Robob Cards is being made for it now.</p>
<p class="note">This page updates by itself in a minute or two.</p>`,
    });
  }
  if (phase === "ready") {
    const install = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    return layout({
      title: "Install Robob Cards",
      body: `<h1>Install Robob Cards</h1>
<p>Your iPhone is registered and the app is ready.</p>
<a class="action" href="${escapeXml(install)}">Install</a>
${list(STEPS.install)}
<p class="note">Nothing happens? Make sure this page is open in Safari, then tap Install again.</p>`,
    });
  }
  if (phase === "failed") {
    return layout({
      title: "Something went wrong",
      body: `<h1>Something went wrong</h1>
<p>Nothing to do on your side. We know about it and will send you a new link.</p>`,
    });
  }
  return layout({
    title: "Get Robob Cards",
    body: `<h1>Get Robob Cards</h1>
<p>Robob's cards will open right inside Messages. It takes about five minutes.</p>
<a class="action" href="profile.mobileconfig">Register this iPhone</a>
${list(STEPS.register)}
<p class="note">Open this page in Safari on the iPhone that should get the app.</p>`,
  });
}
