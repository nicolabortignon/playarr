// Walk the web app in Safari on an iOS Simulator and screenshot it, through the repo's Web Inspector client
// (scripts/ios-sim/rwi.mjs). One connection lasts the whole walk and reconnects only when it drops: a new one per
// command times out on a busy simulator. The steps (steps.json) are [op, argument, option]:
//
//   go <path> [ms]       load a page afresh, then let it settle for [ms]
//   nav <path> [ms]      move to a page inside the app, as its links do: what's playing carries on
//   click <what> [ms]    tap a button, link, tab… by its name (aria-label or text), or { text, css, nth }
//   fill { into, text }  type into an input, then put the keyboard away (as Done would)
//   key <key>            press a key (Escape…) where the focus is
//   scroll <screens>     scroll the page by that many screens
//   eval <js>            run a JavaScript expression in the page
//   wait <ms>            wait
//   shot <name>          take a screenshot, NN-name.png
//   needs <shot>         for runs filtered to a few shots: walk that shot's page too, first (what this page builds on)
//
// A page is the steps from one go or nav to the next; a filtered run walks only the pages it needs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SimInspector } from '../ios-sim/rwi.mjs';

const SAFARI = 'com.apple.mobilesafari';
const OPS = new Set(['go', 'nav', 'click', 'fill', 'key', 'scroll', 'eval', 'wait', 'shot', 'needs']);
// Screenshots are scaled to this many pixels tall: small type stays readable at about a third of the size.
const HEIGHT = 1600;

// What simctl says on stderr goes into the error when it fails, and nowhere otherwise.
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iosVersion = (s) => s.match(/(\d+)[.-](\d+)/)?.slice(1).map(Number) ?? [0, 0];
const byVersion = (a, b) => a[0] - b[0] || a[1] - b[1];

/** The simulator called `name`; made from `type` on the newest iOS that runs it when there's none yet. */
function simulator(name, type) {
  const find = () => {
    const { devices } = JSON.parse(simctl('list', 'devices', 'available', '-j'));
    return Object.entries(devices)
      .filter(([runtime]) => runtime.includes('.iOS-'))
      .sort(([a], [b]) => byVersion(iosVersion(a), iosVersion(b)))
      .flatMap(([runtime, list]) => list.map((d) => ({ ...d, ios: iosVersion(runtime).join('.') })))
      .findLast((d) => d.name === name);
  };
  const found = find();
  if (found) return found;
  const { runtimes } = JSON.parse(simctl('list', 'runtimes', 'available', '-j'));
  const runtime = runtimes
    .filter((r) => r.platform === 'iOS' && r.supportedDeviceTypes?.some((t) => t.name === type))
    .sort((a, b) => byVersion(iosVersion(a.version), iosVersion(b.version)))
    .at(-1);
  if (!runtime) throw new Error(`No iOS simulator runtime runs the ${type}: add one in Xcode → Settings → Components`);
  console.log(`  making the simulator “${name}”: ${type}, iOS ${runtime.version}`);
  simctl('create', name, type, runtime.identifier);
  return find();
}

/**
 * Apple's 9:41 (on 13 January 2026, in this Mac's time zone, so the iPad's date is the same every run), full Wi-Fi
 * and signal, a full battery, no carrier. simctl takes the time only as toISOString() writes it.
 */
function overrideStatusBar(udid) {
  const time = new Date(2026, 0, 13, 9, 41).toISOString();
  simctl('status_bar', udid, 'override', '--time', time, '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
    '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100');
}

/** Safari's TipKit store in the simulator (which tips it has shown), once Safari has run there. */
function tipStore(device) {
  const groups = join(device.dataPath, 'Containers', 'Shared', 'AppGroup');
  for (const group of existsSync(groups) ? readdirSync(groups) : []) {
    const store = join(groups, group, SAFARI, '.tipkit', 'tips-store.db');
    if (existsSync(store)) return store;
  }
  return null;
}
const sql = (store, query, ...flags) => execFileSync('sqlite3', [...flags, store, query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Turn Safari's tips off: on its first run Safari puts one over the page (TipForMoreButton, about the ⋯ button).
 * TipKit keeps tips in a SQLite store, where status 0 is a tip that's done with; Safari must be closed while it
 * changes. `wait` gives a new simulator's Safari time to record that tip first (the iPad has none, so it waits in
 * vain, once). Returns whether it closed Safari.
 */
async function quietSafariTips(device, wait) {
  // A store Safari is still setting up may not have its table yet.
  const count = (store, where) => {
    try {
      return Number(sql(store, `SELECT COUNT(*) FROM ZCORETIPRECORD WHERE ${where}`, '-readonly'));
    } catch {
      return 0;
    }
  };
  let store = tipStore(device);
  for (const deadline = Date.now() + (wait ? 20_000 : 0); Date.now() < deadline && !(store && count(store, "ZID LIKE '%TipForMoreButton%'")); await sleep(1000)) {
    store = tipStore(device);
  }
  if (!store || !count(store, 'ZSTATUSVALUE != 0')) return false;
  try {
    simctl('terminate', device.udid, SAFARI);
  } catch {
    // Safari wasn't running
  }
  sql(store, 'UPDATE ZCORETIPRECORD SET ZSTATUSVALUE = 0 WHERE ZSTATUSVALUE != 0');
  return true;
}

/**
 * The addresses of the tabs Safari keeps, and restores when it starts ('' for a tab showing the Start Page), from its
 * tab store; null when there's none to read.
 */
function safariTabs(device) {
  const store = join(device.dataPath, 'Library', 'Safari', 'SafariTabs.db');
  if (!existsSync(store)) return null;
  try {
    const local = "(SELECT id FROM bookmarks WHERE type = 1 AND title = 'Local')";
    const rows = sql(store, `SELECT 'tab ' || ifnull(url, '') FROM bookmarks WHERE type = 0 AND hidden = 0 AND deleted = 0 AND parent = ${local}`, '-readonly');
    return rows ? rows.split('\n').map((row) => row.slice(4)) : [];
  } catch {
    return null;
  }
}

const hasSafari = (rwi) => Object.values(rwi.apps).some((app) => app.WIRApplicationBundleIdentifierKey === SAFARI);

/**
 * A new inspector connection, attached to Safari's newest tab (the one on screen, as there's one). Safari isn't
 * always in the first list of apps a connection gets, so it's asked for again.
 */
async function attachToSafari(socket) {
  const rwi = new SimInspector(socket);
  try {
    await rwi.connect();
    for (let ask = 0; ask < 3 && !hasSafari(rwi); ask++) {
      rwi.post('_rpc_getConnectedApplications:', { WIRConnectionIdentifierKey: rwi.connId });
      await rwi.until((m) => m.__selector === '_rpc_reportConnectedApplicationList:', 2000).catch(() => {});
    }
    const page = (await rwi.pages()).at(-1);
    if (!page) throw new Error('Safari has no page open');
    await rwi.attach(page.id);
    return rwi;
  } catch (err) {
    rwi.close();
    throw err;
  }
}

// In the page: the element a step means. Its name is what a screen reader would call it, near enough: aria-label,
// what aria-labelledby points at, or its text. textContent, not innerText: innerText is empty for cards that
// content-visibility: auto hasn't drawn yet.
const FIND = `(spec) => {
  const sel = spec.css ?? 'a, button, input, textarea, select, summary, label, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio]';
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const labelledBy = (e) => norm((e.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => id && document.getElementById(id)?.textContent).join(' '));
  const name = (e) => norm(e.getAttribute('aria-label')) || labelledBy(e) || norm(e.textContent) || norm(e.getAttribute('placeholder')) || norm(e.title);
  const els = [...document.querySelectorAll(sel)].filter(visible);
  let found = els;
  if (spec.text != null) {
    found = els.filter((e) => name(e) === spec.text);
    if (!found.length) found = els.filter((e) => name(e).startsWith(spec.text));
    if (!found.length) found = els.filter((e) => name(e).includes(spec.text));
  }
  return found[spec.nth ?? 0] ?? null;
}`;
// In the page: scroll the biggest scroller (the window, or an open sheet's) by a number of its heights.
const SCROLL = `(screens) => {
  const all = [document.scrollingElement, ...document.querySelectorAll('*')].filter((e) => e && e.scrollHeight > e.clientHeight + 20 && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY)));
  const el = all.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
  el?.scrollBy({ top: screens * el.clientHeight, behavior: 'instant' });
  return !!el;
}`;
// In the page: a new entry as React Router makes them ({ usr, key, idx }), then a popstate for the router to follow.
// A key of its own matters: under a reused one the router restores that entry's scroll position.
const NAV = `(path) => {
  history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: (history.state?.idx ?? 0) + 1 }, '', path);
  dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  return true;
}`;

/** Check steps.json's steps for a device; throws on an unknown op or a needs that names no shot. */
export function checkSteps(steps, key) {
  const shots = new Set(steps.filter(([op]) => op === 'shot').map(([, name]) => name));
  for (const [op, arg] of steps) {
    if (!OPS.has(op)) throw new Error(`steps.json, ${key}: unknown step “${op}”`);
    if (op === 'needs' && !shots.has(arg)) throw new Error(`steps.json, ${key}: needs “${arg}”, which no shot is called`);
  }
  return [...shots];
}

/** Whether shot `name` is one of `only` (a name, or a name and what follows a dash: "album" takes "album-2"). */
export const wanted = (name, only) => !only || only.some((o) => name === o || name.startsWith(`${o}-`));

/**
 * The steps to take: all of them, or for `only` the pages with those shots and the pages they need. Shots are
 * numbered as in a full walk, so a filtered run replaces the same files.
 */
function plan(steps, only) {
  let n = 0;
  const numbered = steps.map(([op, arg, opt]) => ({ op, arg, opt, number: op === 'shot' ? ++n : 0 }));
  const width = Math.max(2, String(n).length);
  if (!only) return { steps: numbered, width };
  const pages = [];
  for (const step of numbered) {
    if (!pages.length || step.op === 'go' || step.op === 'nav') pages.push([]);
    pages.at(-1).push(step);
  }
  const keep = new Set();
  const take = (page) => {
    if (keep.has(page)) return;
    keep.add(page);
    for (const step of page.filter((s) => s.op === 'needs')) take(pages.find((p) => p.some((s) => s.op === 'shot' && s.arg === step.arg)));
  };
  pages.filter((page) => page.some((s) => s.op === 'shot' && wanted(s.arg, only))).forEach(take);
  return { steps: pages.filter((page) => keep.has(page)).flat(), width };
}

class PageError extends Error {}

/**
 * Safari's page, through one inspector connection, held from Safari's start to the end of the walk and made again
 * only when it drops: a new connection per command times out on a busy simulator.
 */
function session(socket) {
  let rwi = null;

  /**
   * Start Safari afresh, on a tab to drive. Safari restores its tab, which starts blank and fills in from Safari's
   * cache a moment later (navigating before then races it); a tab with nothing in it (a new simulator's, or a Start
   * Page, whose blank page is under Safari's own) takes `url`. Only then: openurl adds a tab when there's one
   * already, which the screen shows but the inspector may not drive, and a new simulator's Safari ignores it as the
   * first thing it's asked.
   */
  async function open(device, url) {
    try {
      simctl('terminate', device.udid, SAFARI);
    } catch {
      // it wasn't running
    }
    rwi?.close();
    rwi = null;
    const probe = new SimInspector(socket);
    try {
      // Connected before Safari starts, so as to hear it arrive.
      await probe.connect();
      simctl('launch', device.udid, SAFARI);
      for (const deadline = Date.now() + 20_000; !hasSafari(probe); await sleep(250)) {
        if (Date.now() > deadline) throw new Error('Safari started but never showed up in the Web Inspector');
      }
      let opened = false;
      const openUrl = () => {
        simctl('openurl', device.udid, url);
        opened = true;
      };
      const tabs = safariTabs(device);
      if (tabs && !tabs.some(Boolean)) openUrl();
      let pages = [];
      for (const start = Date.now(); !pages.at(-1) || pages.at(-1).url.startsWith('about:'); await sleep(500)) {
        // Still blank after a while: a tab with nothing in it after all.
        if (!opened && Date.now() - start > 15_000) openUrl();
        if (Date.now() - start > 35_000) throw new Error('Safari opened no page the Web Inspector can reach');
        pages = await probe.pages();
      }
      if (pages.length > 1) console.warn(`  Safari has ${pages.length} tabs open: the tour drives the newest, which the screen may not show`);
      await probe.attach(pages.at(-1).id);
      rwi = probe;
    } catch (err) {
      probe.close();
      throw err;
    }
  }

  // Run JavaScript in the page. Errors thrown in the page come back as such and aren't retried; `raw` sends the
  // expression as it is, for a navigation, whose page is gone before a promise could answer.
  async function ev(expression, { raw = false, tries = 4 } = {}) {
    const code = raw ? expression : `(async () => { try { return { value: await (${expression}) }; } catch (e) { return { error: String(e) }; } })()`;
    for (let attempt = 1; ; attempt++) {
      try {
        rwi ??= await attachToSafari(socket);
        const result = await rwi.evaluate(code);
        if (raw) return result;
        if (result?.error) throw new PageError(result.error);
        return result?.value;
      } catch (err) {
        if (err instanceof PageError) throw err;
        rwi?.close();
        rwi = null;
        if (attempt >= tries) throw err;
        await sleep(1500 * attempt);
      }
    }
  }
  // Wait for the page's images and fonts (up to 4 s), then a moment for what they move.
  async function settle(ms = 900) {
    await sleep(ms);
    await ev(`Promise.race([
      Promise.all([document.fonts.ready, ...[...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))]),
      new Promise((r) => setTimeout(r, 4000)),
    ]).then(() => true)`, { tries: 2 }).catch(() => {});
    await sleep(300);
  }
  // A full page load, checked to have landed on the server (Safari restoring a tab can overtake it). Scrolled to the
  // top first: React Router keeps the scroll position of the page being left and gives it to the next page loaded
  // afresh, as neither has a history key of its own.
  async function goto(url, ms = 2000) {
    for (let attempt = 1; ; attempt++) {
      await ev(`(scrollTo(0, 0), window.__webScreensLeaving = true, void location.assign(${JSON.stringify(url)}))`, { raw: true });
      let page = null;
      for (const deadline = Date.now() + 40_000; !(page?.fresh && page.ready === 'complete'); await sleep(400)) {
        if (Date.now() > deadline) throw new Error(`${url} didn't load within 40 s`);
        page = await ev('({ fresh: !window.__webScreensLeaving, ready: document.readyState, href: location.href })', { tries: 2 }).catch(() => null);
      }
      if (page.href.startsWith(new URL(url).origin)) break;
      if (attempt === 3) throw new Error(`${url} didn't load: the tab shows ${page.href}`);
    }
    await settle(ms);
  }
  return { open, ev, settle, goto, close: () => rwi?.close() };
}

/**
 * Sign in as Safari would: the app keeps the account and its token in localStorage, and switching to it sets the
 * session cookie. A switch made while the page is still loading may not stick, so it's made again until a request
 * with the cookie gets through.
 */
async function signIn(page, base, account) {
  await page.goto(`${base}/sign-in`, 1500);
  for (let attempt = 1; ; attempt++) {
    const status = await page.ev(`(async ({ username, password }) => {
      const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Playarr': '1' }, body: JSON.stringify(body) });
      let stored = JSON.parse(localStorage.getItem('playarr.accounts') ?? '[]').find((a) => a.username === username);
      if (!stored) {
        const ua = navigator.userAgent;
        const device = 'Safari on ' + (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : 'Mac');
        const res = await post('/api/auth/sign-in', { username, password, device, platform: 'web' });
        if (!res.ok) return res.status;
        const { token, account } = await res.json();
        stored = { accountId: account.id, name: account.name, username: account.username, token };
        localStorage.setItem('playarr.accounts', JSON.stringify([stored]));
      }
      await post('/api/auth/switch', { token: stored.token });
      return (await fetch('/api/auth/me', { headers: { 'X-Playarr': '1' } })).status;
    })(${JSON.stringify(account)})`).catch((err) => err.message);
    if (status === 200) return;
    if (attempt === 6) throw new Error(`Couldn't sign in to ${base} in Safari (${status})`);
    await sleep(1000 * attempt);
  }
}

/** Take one step. Returns false when there was nothing to tap or type into. */
async function step(page, { op, arg, opt }, base) {
  if (op === 'go') {
    await page.goto(base + arg, opt ?? 2000);
  } else if (op === 'nav') {
    await page.ev(`(${NAV})(${JSON.stringify(arg)})`);
    await page.settle(opt ?? 1300);
  } else if (op === 'click') {
    const spec = JSON.stringify(typeof arg === 'string' ? { text: arg } : arg);
    if (!(await page.ev(`(() => { const e = (${FIND})(${spec}); e?.scrollIntoView({ block: 'center' }); return !!e; })()`))) return false;
    await sleep(350);
    await page.ev(`(() => { const e = (${FIND})(${spec}); e?.click(); return !!e; })()`);
    await page.settle(opt ?? 800);
  } else if (op === 'fill') {
    const typed = await page.ev(`(() => {
      const e = (${FIND})(${JSON.stringify(arg.into)});
      if (!e) return false;
      e.focus();
      const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(arg.text)});
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.blur();
      return true;
    })()`);
    if (!typed) return false;
    await page.settle(opt ?? 1800);
  } else if (op === 'key') {
    await page.ev(`(() => { const t = document.activeElement ?? document.body; for (const type of ['keydown', 'keyup']) t.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(arg)}, bubbles: true })); return true; })()`);
    await page.settle(opt ?? 600);
  } else if (op === 'scroll') {
    await page.ev(`(${SCROLL})(${arg})`);
    await page.settle(opt ?? 700);
  } else if (op === 'eval') {
    await page.ev(arg);
    await page.settle(opt ?? 500);
  } else if (op === 'wait') {
    await sleep(arg);
  }
  return true;
}

/**
 * Walk `steps` on the simulator `device` ({ simulator, type }) against the server at `base`, signed in as
 * `account` ({ username, password }), into `out`. `only` limits the walk to some shots. Returns { shots, failed }.
 */
export async function walk({ device: { simulator: name, type }, base, account, steps, out, only }) {
  // rwi's timers don't hold the process open: without this, it can end quietly mid-walk.
  const keepAlive = setInterval(() => {}, 60_000);
  const device = simulator(name, type);
  let booted = device.state !== 'Booted';
  let page = null;
  try {
    console.log(`  ${device.name}: ${type}, iOS ${device.ios}`);
    if (booted) simctl('boot', device.udid);
    simctl('bootstatus', device.udid, '-b');
    // More than one tab and the tour may drive one the screen doesn't show: start from a clean simulator (it's
    // the tour's own).
    const tabs = safariTabs(device);
    if (tabs?.length > 1) {
      console.log(`  Safari keeps ${tabs.length} tabs here: erasing the simulator, for one`);
      simctl('shutdown', device.udid);
      simctl('erase', device.udid);
      simctl('boot', device.udid);
      simctl('bootstatus', device.udid, '-b');
      booted = true;
    }
    overrideStatusBar(device.udid);
    const fresh = !tipStore(device);
    page = session(simctl('getenv', device.udid, 'RWI_LISTEN_SOCKET'));
    await page.open(device, `${base}/sign-in`);
    // Turning the tips off closes Safari: open it again.
    if (await quietSafariTips(device, fresh)) await page.open(device, `${base}/sign-in`);
    await signIn(page, base, account);

    const { steps: todo, width } = plan(steps, only);
    if (!only) rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const failed = [];
    let shots = 0;
    let lost = 0;
    for (const s of todo) {
      const what = `${s.op} ${JSON.stringify(s.arg)}`;
      try {
        if (s.op === 'shot') {
          if (!wanted(s.arg, only)) continue;
          const name = `${String(s.number).padStart(width, '0')}-${s.arg}`;
          const file = join(out, `${name}.png`);
          simctl('io', device.udid, 'screenshot', file);
          execFileSync('sips', ['-Z', String(HEIGHT), file], { stdio: 'ignore' });
          console.log(`  ${name}`);
          shots++;
        } else if (!(await step(page, s, base))) {
          failed.push(`${what}: nothing on the page matches`);
          console.log(`  ✗ ${what}: nothing on the page matches`);
        }
        lost = 0;
      } catch (err) {
        failed.push(`${what}: ${err.message}`);
        console.log(`  ✗ ${what}: ${err.message}`);
        // Errors from the page are the page's; three of any other kind in a row and Safari is gone.
        if (!(err instanceof PageError) && ++lost === 3) throw new Error(`Lost Safari after ${shots} screens: ${err.message}`);
      }
    }
    // Leave Safari tidy: the music stopped, and this origin's storage and service worker cleared (the next run has
    // a port, so an origin, of its own). The tab stays: Safari restores it next time, for the tour to drive again.
    await page.ev(`(async () => {
      for (const audio of document.querySelectorAll('audio')) audio.pause();
      for (const r of (await navigator.serviceWorker?.getRegistrations()) ?? []) await r.unregister();
      for (const name of (await globalThis.caches?.keys()) ?? []) await caches.delete(name);
      for (const db of (await indexedDB.databases?.()) ?? []) indexedDB.deleteDatabase(db.name);
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })()`).catch(() => {});
    return { shots, failed };
  } finally {
    page?.close();
    clearInterval(keepAlive);
    if (booted) {
      try {
        simctl('shutdown', device.udid);
      } catch {
        // already shut down
      }
    }
  }
}
