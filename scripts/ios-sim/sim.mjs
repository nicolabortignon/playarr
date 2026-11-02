// Drive Playarr in Safari on an iOS Simulator: open pages, tap and type, read the console, take
// screenshots. Needs Xcode. Usage: pnpm sim help. Also importable, for scripted walk-throughs.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SimInspector } from './rwi.mjs';

const DEFAULT_DEVICE = 'iPhone 17 Pro';
const DEFAULT_URL = process.env.PLAYARR_URL ?? 'http://192.168.1.103:4000';
const SHOT = '/tmp/playarr-sim.png';

const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function devices() {
  const { devices } = JSON.parse(simctl('list', 'devices', 'available', '-j'));
  // Oldest iOS first (simctl lists runtimes in no set order), so the last match of a name is on the newest.
  const version = (runtime) => runtime.match(/iOS-(\d+)-(\d+)/)?.slice(1).map(Number) ?? [0, 0];
  return Object.entries(devices)
    .filter(([runtime]) => runtime.includes('iOS'))
    .sort(([a], [b]) => version(a)[0] - version(b)[0] || version(a)[1] - version(b)[1])
    .flatMap(([runtime, list]) => list.map((d) => ({ ...d, runtime: runtime.split('.').pop() })));
}

function bootedDevice() {
  const device = devices().find((d) => d.state === 'Booted');
  if (!device) throw new Error('No simulator is running: pnpm sim boot');
  return device;
}

/** Start a simulator (if it isn't already) and wait until it's ready. `show` opens its window too. */
export function boot(name = DEFAULT_DEVICE, { show = false } = {}) {
  const device = devices().findLast((d) => d.name === name);
  if (!device) throw new Error(`No simulator named “${name}”. Try: xcrun simctl list devices available`);
  if (device.state !== 'Booted') simctl('boot', device.udid);
  simctl('bootstatus', device.udid, '-b');
  if (show) execFileSync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid]);
  return device;
}

export function shutdown() {
  simctl('shutdown', bootedDevice().udid);
}

/** Inspect Safari's newest tab. Close it when done. */
export async function connect() {
  const rwi = new SimInspector(simctl('getenv', bootedDevice().udid, 'RWI_LISTEN_SOCKET'));
  try {
    await rwi.connect();
    const page = (await rwi.pages()).at(-1);
    if (!page) throw new Error('Safari has no page open: pnpm sim open <url>');
    await rwi.attach(page.id);
    return rwi;
  } catch (err) {
    rwi.close();
    throw err;
  }
}

async function withPage(fn) {
  const rwi = await connect();
  try {
    return await fn(rwi);
  } finally {
    rwi.close();
  }
}

async function currentUrl() {
  return withPage((rwi) => rwi.evaluate('location.href')).catch(() => undefined);
}

/**
 * Open a URL (or a path on the open page's server, else on PLAYARR_URL) in Safari and wait for it to
 * load. Reuses the open tab, so tabs don't pile up.
 */
export async function open(target = '/', { timeoutMs = 30_000 } = {}) {
  const before = await currentUrl();
  const url = new URL(target, before ?? DEFAULT_URL).href;
  if (before) await withPage((rwi) => rwi.evaluate(`void location.assign(${JSON.stringify(url)})`));
  else simctl('openurl', bootedDevice().udid, url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const state = await withPage((rwi) => rwi.evaluate('({ href: location.href, ready: document.readyState })')).catch(() => undefined);
    if (state?.ready === 'complete' && (state.href === url || state.href !== before)) return state.href;
  }
  throw new Error(`${url} didn’t finish loading within ${timeoutMs / 1000} s`);
}

/** Run JavaScript in the page and return its value (promises are awaited). */
export function evaluate(expression) {
  return withPage((rwi) => rwi.evaluate(expression));
}

// In the page: an element from a CSS selector, or from what it says ("text=Play"): a visible button,
// link, tab… whose text or aria-label matches, exactly if possible.
const FIND = `(spec) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  if (!spec.startsWith('text=')) return [...document.querySelectorAll(spec)].find(visible) ?? null;
  const want = spec.slice(5).trim().toLowerCase();
  const tappable = 'a, button, input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox]';
  const names = (el) => [el.innerText, el.getAttribute('aria-label'), el.value].map((s) => (s ?? '').trim().replace(/\\s+/g, ' ').toLowerCase());
  const els = [...document.querySelectorAll(tappable)].filter(visible);
  return els.find((el) => names(el).includes(want)) ?? els.find((el) => names(el).some((n) => n.includes(want))) ?? null;
}`;
const DESCRIBE = `(el) => el.tagName.toLowerCase() + (el.getAttribute('href') ? ' ' + el.getAttribute('href') : '') + ' “' + (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60) + '”'`;

function inPage(spec, body) {
  return `(() => { const el = (${FIND})(${JSON.stringify(spec)}); if (!el) return null; ${body} })()`;
}

/** Tap an element (CSS selector or "text=…"); returns what was tapped. */
export async function click(spec) {
  const tapped = await evaluate(inPage(spec, `el.scrollIntoView({ block: 'center' }); el.click(); return (${DESCRIBE})(el);`));
  if (!tapped) throw new Error(`Nothing to tap matches ${spec}`);
  return tapped;
}

/** Type into an input (replacing what's there), the way React sees typing. */
export async function fill(spec, text) {
  const filled = await evaluate(
    inPage(
      spec,
      `el.focus();
       const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
       el.dispatchEvent(new Event('input', { bubbles: true }));
       return (${DESCRIBE})(el);`,
    ),
  );
  if (!filled) throw new Error(`No input matches ${spec}`);
  return filled;
}

/** Wait until an element (CSS selector or "text=…") is on screen. */
export async function waitFor(spec, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(inPage(spec, `return (${DESCRIBE})(el);`)).catch(() => null);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`${spec} didn’t appear within ${timeoutMs / 1000} s`);
}

/** The page's console since it loaded (Safari replays it): [{ level, text, where }]. */
export function consoleMessages() {
  return withPage(async (rwi) => {
    await rwi.send('Console.enable');
    await sleep(300);
    return rwi.events
      .filter((e) => e.method === 'Console.messageAdded')
      .map(({ params: { message: m } }) => ({ level: m.level, text: m.text, where: m.url ? `${m.url}:${m.line}` : '' }));
  });
}

/** Save a screenshot of the simulator's screen, scaled down to 900 px tall (small enough to review). */
export function screenshot(file = SHOT) {
  simctl('io', bootedDevice().udid, 'screenshot', file);
  execFileSync('sips', ['-Z', '900', file], { stdio: 'ignore' });
  return file;
}

const HELP = `pnpm sim <command>

  boot [device] [--show]      start a simulator (default “${DEFAULT_DEVICE}”); --show opens its window
  open [url|path] [--wait X]  load a page in Safari (paths resolve against the open page, else
                              ${DEFAULT_URL}; set PLAYARR_URL to change); --wait for element X
  click <X>                   tap element X
  fill <X> <text>             type into input X
  wait <X>                    wait until element X is on screen
  eval <js>                   run JavaScript in the page and print the result
  console [--errors]          the page's console since it loaded (--errors: warnings and errors only)
  shot [file]                 screenshot (default ${SHOT})
  shutdown                    stop the simulator

  X is a CSS selector, or text=… to match a button or link by what it says (or its aria-label).`;

async function main([command, ...rest]) {
  const flag = (name) => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const [, value] = rest.splice(i, 2);
    return value ?? true;
  };
  switch (command) {
    case 'boot': {
      const show = rest.includes('--show');
      const d = boot(rest.find((a) => a !== '--show'), { show });
      return `${d.name} (${d.runtime}) is running`;
    }
    case 'open': {
      const wait = flag('--wait');
      const href = await open(rest[0]);
      return wait ? `${href}\n${await waitFor(wait)}` : href;
    }
    case 'click':
      return click(rest[0]);
    case 'fill':
      return fill(rest[0], rest[1] ?? '');
    case 'wait':
      return waitFor(rest[0]);
    case 'eval': {
      const value = await evaluate(rest.join(' '));
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }
    case 'console': {
      const errorsOnly = rest.includes('--errors');
      const messages = (await consoleMessages()).filter((m) => !errorsOnly || m.level === 'error' || m.level === 'warning');
      return messages.map((m) => `[${m.level}] ${m.text}${m.where ? `  (${m.where})` : ''}`).join('\n') || 'No console messages';
    }
    case 'shot':
      return screenshot(rest[0]);
    case 'shutdown':
      return shutdown();
    default:
      return HELP;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => out && console.log(out),
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
