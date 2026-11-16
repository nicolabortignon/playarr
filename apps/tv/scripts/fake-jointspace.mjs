#!/usr/bin/env node
// A stand-in for a Philips TV's JointSpace API (version 6), for trying Settings → Ambilight without the TV (plan 9 §6):
// HTTPS on 1926 with a self-signed certificate, pairing with a PIN printed here, Digest authentication after it, and the
// Ambilight's mode, style, power, topology and colors (each color sent is printed). On the emulator,
// `adb reverse tcp:1926 tcp:1926` makes the emulator's own 127.0.0.1:1926 this server, as the TV's is its JointSpace.
//
//   node apps/tv/scripts/fake-jointspace.mjs

import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "build", "jointspace");
const key = join(dir, "key.pem");
const cert = join(dir, "cert.pem");
if (!existsSync(cert)) {
  mkdirSync(dir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365", "-subj", "/CN=Fake Philips TV", "-keyout", key, "-out", cert], { stdio: "ignore" });
}

const SHARED_KEY = Buffer.from("ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==", "base64");
const REALM = "XTV";
const md5 = (s) => createHash("md5").update(s).digest("hex");

let pending = null; // { id, authKey, timestamp, pin }
const paired = new Map(); // id → authKey
let mode = "internal";
let configuration = { styleName: "FOLLOW_VIDEO", isExpert: false, menuSetting: "STANDARD" };
const topology = { layers: 1, left: 4, top: 9, right: 4, bottom: 0 };

function challenge(res) {
  res.writeHead(401, { "WWW-Authenticate": `Digest realm="${REALM}", qop="auth,auth-int", nonce="${randomBytes(16).toString("hex")}"`, "Content-Type": "text/plain" });
  res.end("Unauthorized");
}

/** The Digest user, if the Authorization header answers for a known password. */
function digestUser(req, passwordFor) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Digest ")) return null;
  const p = Object.fromEntries([...header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
  const password = passwordFor(p.username);
  if (!password) return null;
  const ha1 = md5(`${p.username}:${p.realm}:${password}`);
  const ha2 = md5(`${req.method}:${p.uri}`);
  const expected = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  return expected === p.response ? p.username : null;
}

const json = (res, value, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

const hex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : null;
  const path = req.url.split("?")[0];

  if (path === "/6/system") return json(res, { name: "Fake Philips TV", api_version: { Major: 6, Minor: 2, Patch: 0 } });

  if (path === "/6/pair/request") {
    pending = { id: data.device.id, authKey: randomBytes(32).toString("hex"), timestamp: Math.floor(Date.now() / 1000), pin: String(1000 + Math.floor(Math.random() * 9000)) };
    console.log(`pair/request from ${data.device.device_name} (${data.device.id}): the TV shows PIN ${pending.pin}`);
    return json(res, { error_id: "SUCCESS", error_text: "Authorization required", auth_key: pending.authKey, timestamp: pending.timestamp, timeout: 60 });
  }

  if (path === "/6/pair/grant") {
    if (!pending || !digestUser(req, (u) => (u === pending.id ? pending.authKey : null))) return challenge(res);
    const { pin, auth_signature, auth_timestamp } = data.auth;
    const expected = createHmac("sha1", SHARED_KEY).update(`${auth_timestamp}${pin}`).digest("base64");
    if (pin !== pending.pin || auth_signature !== expected) {
      console.log(`pair/grant refused: pin ${pin}, signature ${auth_signature === expected ? "good" : "bad"}`);
      return json(res, { error_id: "INVALID_PIN", error_text: "Wrong PIN" });
    }
    paired.set(pending.id, pending.authKey);
    console.log(`pair/grant: paired ${pending.id}`);
    pending = null;
    return json(res, { error_id: "SUCCESS", error_text: "Pairing completed" });
  }

  if (path.startsWith("/6/ambilight/")) {
    if (!digestUser(req, (u) => paired.get(u))) return challenge(res);
    const what = path.slice("/6/ambilight/".length);
    if (what === "mode") {
      if (req.method === "POST") {
        mode = data.current;
        console.log(`mode → ${mode}`);
        return json(res, {});
      }
      return json(res, { current: mode });
    }
    if (what === "currentconfiguration") {
      if (req.method === "POST") {
        configuration = data;
        console.log(`style → ${JSON.stringify(data)}`);
        return json(res, {});
      }
      return json(res, configuration);
    }
    if (what === "power") return json(res, { power: "On" });
    if (what === "topology") return json(res, topology);
    if (what === "cached" && req.method === "POST") {
      const layer = data.layer1 ?? {};
      console.log(`colors (${mode}): left ${hex(layer.left["0"])} top ${hex(layer.top["0"])} right ${hex(layer.right["0"])}`);
      return json(res, {});
    }
  }
  json(res, { error: "not here" }, 404);
}).listen(1926, () => console.log("Fake JointSpace on https://localhost:1926/6/"));
