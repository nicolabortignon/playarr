// A small client for an iOS Simulator's Web Inspector socket: the connection Mac Safari's Develop menu
// uses. Each message is a 4-byte big-endian length then a binary plist {__selector, __argument};
// inspector-protocol JSON travels inside those as data. Safari puts each page behind a Target.
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import bplistCreator from 'bplist-creator';
import * as bplistParser from 'bplist-parser';

const SAFARI = 'com.apple.mobilesafari';

const timer = (ms, fn) => setTimeout(fn, ms).unref();

export class SimInspector {
  /** @param {string} socketPath the simulator's RWI_LISTEN_SOCKET */
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.connId = randomUUID();
    this.senderId = randomUUID();
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.apps = {};
    this.nextId = 1;
    this.pending = new Map();
    /** Inspector events received from the page (Console.messageAdded…). */
    this.events = [];
  }

  async connect() {
    this.socket = net.connect(this.socketPath);
    await new Promise((resolve, reject) => this.socket.once('connect', resolve).once('error', reject));
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.post('_rpc_reportIdentifier:', { WIRConnectionIdentifierKey: this.connId });
    await this.until((m) => m.__selector === '_rpc_reportConnectedApplicationList:', 5000);
  }

  close() {
    this.socket?.destroy();
  }

  post(selector, argument) {
    const plist = bplistCreator({ __selector: selector, __argument: argument });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(plist.length, 0);
    this.socket.write(Buffer.concat([header, plist]));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + size) break;
      const msg = bplistParser.parseBuffer(this.buffer.subarray(4, 4 + size))[0];
      this.buffer = this.buffer.subarray(4 + size);
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    const arg = msg.__argument ?? {};
    if (msg.__selector === '_rpc_reportConnectedApplicationList:') Object.assign(this.apps, arg.WIRApplicationDictionaryKey);
    if (msg.__selector === '_rpc_applicationConnected:') this.apps[arg.WIRApplicationIdentifierKey] = arg;
    if (msg.__selector === '_rpc_applicationSentData:') {
      this.onInspectorMessage(JSON.parse(Buffer.from(arg.WIRMessageDataKey).toString('utf8')));
    }
    for (const w of [...this.waiters]) {
      if (!w.match(msg)) continue;
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  }

  onInspectorMessage(m) {
    if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page') this.targetId = m.params.targetInfo.targetId;
    if (m.method === 'Target.targetDestroyed' && m.params.targetId === this.targetId) this.targetId = undefined;
    if (m.method === 'Target.dispatchMessageFromTarget') return this.onInspectorMessage(JSON.parse(m.params.message));
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
    if (m.method) this.events.push(m);
  }

  until(match, ms = 10_000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      timer(ms, () => {
        const i = this.waiters.indexOf(w);
        if (i < 0) return;
        this.waiters.splice(i, 1);
        reject(new Error('The simulator didn’t answer'));
      });
    });
  }

  /** Safari's open tabs, oldest first: [{ id, url, title }]. Empty when Safari isn't running. */
  async pages() {
    const appId = Object.keys(this.apps).find((id) => this.apps[id].WIRApplicationBundleIdentifierKey === SAFARI);
    if (!appId) return [];
    this.appId = appId;
    this.post('_rpc_forwardGetListing:', { WIRConnectionIdentifierKey: this.connId, WIRApplicationIdentifierKey: appId });
    const msg = await this.until((m) => m.__selector === '_rpc_applicationSentListing:');
    return Object.values(msg.__argument.WIRListingKey ?? {})
      .map((p) => ({ id: p.WIRPageIdentifierKey, url: p.WIRURLKey, title: p.WIRTitleKey }))
      .sort((a, b) => a.id - b.id);
  }

  /** Start inspecting a tab (from pages()), for send() and evaluate(). */
  async attach(pageId) {
    this.pageId = pageId;
    this.post('_rpc_forwardSocketSetup:', {
      WIRConnectionIdentifierKey: this.connId,
      WIRApplicationIdentifierKey: this.appId,
      WIRPageIdentifierKey: pageId,
      WIRSenderKey: this.senderId,
      WIRAutomaticallyPause: false,
    });
    await this.until((m) => m.__selector === '_rpc_applicationSentData:' && !!this.targetId, 5000);
  }

  /** Send an inspector-protocol command to the page; resolves with its result. */
  send(method, params = {}) {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    const wrapped = { id: this.nextId++, method: 'Target.sendMessageToTarget', params: { targetId: this.targetId, message } };
    this.post('_rpc_forwardSocketData:', {
      WIRConnectionIdentifierKey: this.connId,
      WIRApplicationIdentifierKey: this.appId,
      WIRPageIdentifierKey: this.pageId,
      WIRSenderKey: this.senderId,
      WIRSocketDataKey: Buffer.from(JSON.stringify(wrapped)),
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      timer(20_000, () => this.pending.delete(id) && reject(new Error(`${method}: no answer from the page`)));
    });
  }

  /** Run a JavaScript expression in the page, as if from a tap; resolves with its (awaited) value. */
  async evaluate(expression) {
    const { result, wasThrown } = await this.send('Runtime.evaluate', { expression, emulateUserGesture: true });
    if (wasThrown) throw new Error(result.description);
    if (!result.objectId) return result.value;
    const settled =
      result.className === 'Promise'
        ? await this.send('Runtime.awaitPromise', { promiseObjectId: result.objectId, returnByValue: true })
        : await this.send('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true });
    if (settled.wasThrown) throw new Error(settled.result.description);
    return settled.result.value;
  }
}
