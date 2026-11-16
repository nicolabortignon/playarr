#!/usr/bin/env node
// A stand-in for GitHub's releases, for trying the sideload flavor's self-update without a real release (plan 9 §7):
// the two API calls TvReleases makes (the tv-v* tags, then a tag's release) and the APK's download, with its size and
// SHA-256 as GitHub gives them. Each APK named playarr-tv-<version>.apk given here is a release. A build pointed at it
// with -PupdatesRepo=http://10.0.2.2:4621/repos/owner/playarr asks it instead of GitHub (docs/tv/release.md).
//
//   node apps/tv/scripts/fake-releases.mjs build/release/playarr-tv-1.0.1.apk [more.apk…]   (PORT=4621)

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename } from "node:path";

const port = Number(process.env.PORT ?? 4621);
const releases = new Map(); // version → { path, size, sha256 }
for (const path of process.argv.slice(2)) {
  const version = basename(path).match(/^playarr-tv-(.+)\.apk$/)?.[1];
  if (!version) throw new Error(`${path}: name it playarr-tv-<version>.apk`);
  releases.set(version, { path, size: statSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
}
if (!releases.size) {
  console.error("Give it one or more playarr-tv-<version>.apk files");
  process.exit(1);
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const base = `http://${req.headers.host}`;
  console.log(req.method, url.pathname);
  if (/^\/repos\/[^/]+\/[^/]+\/git\/matching-refs\/tags\/tv-v$/.test(url.pathname)) {
    return json(res, 200, [...releases.keys()].map((v) => ({ ref: `refs/tags/tv-v${v}`, object: { sha: "0".repeat(40), type: "commit" } })));
  }
  const tag = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/tags\/tv-v(.+)$/)?.[1];
  if (tag) {
    const found = releases.get(tag);
    if (!found) return json(res, 404, { message: "Not Found" });
    const name = `playarr-tv-${tag}.apk`;
    return json(res, 200, {
      tag_name: `tv-v${tag}`,
      draft: false,
      prerelease: false,
      body: `Playarr for TV ${tag}, from the stand-in for GitHub.`,
      assets: [{ name, state: "uploaded", size: found.size, digest: `sha256:${found.sha256}`, browser_download_url: `${base}/download/${name}` }],
    });
  }
  const file = url.pathname.match(/^\/download\/playarr-tv-(.+)\.apk$/)?.[1];
  if (file && releases.has(file)) {
    const found = releases.get(file);
    res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": found.size });
    return res.end(readFileSync(found.path));
  }
  json(res, 404, { message: "Not Found" });
}).listen(port, () => {
  for (const [v, r] of releases) console.log(`tv-v${v}: ${r.path} (${r.size} bytes, sha256 ${r.sha256.slice(0, 12)}…)`);
  console.log(`Fake GitHub releases on :${port}; build with -PupdatesRepo=http://10.0.2.2:${port}/repos/owner/playarr`);
});
