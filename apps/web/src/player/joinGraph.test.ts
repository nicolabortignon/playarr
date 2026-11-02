import { describe, expect, it } from 'vitest';
import { JoinGraph, measureLag } from './joinGraph';

const RATE = 48000;

/** Music-like sound: a kick every half second, a bass note, and hats over a little noise, the same for the same frames. */
function sound(frames: number, from = 0): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = (i + from) / RATE;
    const beat = t % 0.5;
    const kick = Math.exp(-beat * 30) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-beat * 40)) * beat);
    const bass = 0.3 * Math.sin(2 * Math.PI * 55 * t);
    // A deterministic "noise" from the sample index, so two copies of one moment match exactly.
    const n = i + from;
    // Hats on the off-beats over a quiet wash of noise (reverb, a shaker): music always has some grain.
    const grain = ((Math.sin(n * 12.9898) * 43758.5453) % 1) - 0.5;
    const hat = grain * (0.02 + 0.1 * Math.exp(-((t + 0.25) % 0.5) * 60));
    out[i] = 0.6 * kick + bass + hat;
  }
  return out;
}

describe('measuring how far apart two copies of one sound are', () => {
  it('finds the follower ahead or behind to the sample, both ways', () => {
    for (const lag of [0, 1, 7, 480, 960, 2400, -3, -300, -1500]) {
      const lead = sound(8192, 100_000);
      const follower = sound(8192, 100_000 + lag);
      expect(measureLag(lead, follower, 2880), `lag ${lag}`).toMatchObject({ lag });
    }
  });

  it('is sure of an exact copy, and not of a different sound or of silence', () => {
    expect(measureLag(sound(8192, 5000), sound(8192, 5000 + 123), 2880)!.correlation).toBeGreaterThan(0.99);
    const other = Float32Array.from(sound(8192, 5000), (v, i) => v * Math.sin(i * 0.37) + 0.2 * Math.cos(i * 0.011));
    expect(measureLag(sound(8192, 5000), other, 2880)).toBeNull();
    expect(measureLag(new Float32Array(8192), new Float32Array(8192), 2880)).toBeNull();
  });

  it('still finds the lag through a little added noise (two outputs never quite bit for bit)', () => {
    const lead = sound(8192, 70_000);
    const follower = Float32Array.from(sound(8192, 70_000 + 333), (v, i) => v + 0.003 * Math.sin(i * 1.7));
    expect(measureLag(lead, follower, 2880)).toMatchObject({ lag: 333 });
  });
});

describe('the graph', () => {
  /** A stand-in context: nodes that record their connections, and a recorder fed `lead`/`follower` block by block. */
  function fakeContext(lead: (from: number, n: number) => Float32Array, follower: (from: number, n: number) => Float32Array) {
    const nodes: { kind: string; connected: unknown[]; params: Record<string, { value: number; setValueAtTime: (v: number) => void }> }[] = [];
    const param = (value = 0) => {
      const p = { value, setValueAtTime: (v: number) => void (p.value = v), setTargetAtTime: (v: number) => void (p.value = v), cancelScheduledValues: () => {}, linearRampToValueAtTime: (v: number) => void (p.value = v) };
      return p;
    };
    const node = (kind: string, extra: Record<string, unknown> = {}) => {
      const n = {
        kind,
        connected: [] as unknown[],
        params: {},
        connect(to: unknown) {
          n.connected.push(to);
          return to;
        },
        disconnect(to?: unknown) {
          n.connected = to === undefined ? [] : n.connected.filter((c) => c !== to);
        },
        ...extra,
      };
      nodes.push(n as never);
      return n;
    };
    let frame = 0;
    const context = {
      state: 'running',
      sampleRate: RATE,
      currentTime: 0,
      destination: node('destination'),
      createMediaElementSource: () => node('source'),
      createDelay: () => node('delay', { delayTime: param() }),
      createGain: () => node('gain', { gain: param(1) }),
      createChannelMerger: () => node('merger'),
      createScriptProcessor: (size: number) => {
        const recorder = Object.assign(node('recorder'), { onaudioprocess: null as null | ((e: unknown) => void) });
        // Blocks arrive as the audio plays: both channels of the same moment together.
        const timer = setInterval(() => {
          if (!recorder.onaudioprocess) return clearInterval(timer);
          const channels = [lead(frame, size), follower(frame, size)];
          frame += size;
          recorder.onaudioprocess({ inputBuffer: { getChannelData: (c: number) => channels[c] } });
        }, 1);
        return recorder;
      },
    };
    return { context: context as unknown as AudioContext, nodes };
  }

  it('records both outputs together and says how far ahead the follower is, in seconds', async () => {
    const { context, nodes } = fakeContext(
      (from, n) => sound(n, 200_000 + from),
      (from, n) => sound(n, 200_000 + from + 1037),
    );
    const g = JoinGraph.create(context)!;
    const a = document.createElement('audio');
    const b = document.createElement('audio');
    expect(g.route(a) && g.route(b)).toBe(true);
    expect(a.volume).toBe(1);
    expect(await g.lag(a, b)).toBeCloseTo(1037 / RATE, 9);
    // Nothing left connected to the recorder, and each element still plays out: delay → gain → speakers.
    expect(nodes.filter((n) => n.kind === 'recorder' || n.kind === 'merger').every((n) => n.connected.length === 0)).toBe(true);
    expect(nodes.filter((n) => n.kind === 'delay').every((n) => n.connected.length === 1)).toBe(true);
  });

  it('holds a level a cross-fade owns until it is over', () => {
    const { context } = fakeContext(() => new Float32Array(0), () => new Float32Array(0));
    const g = JoinGraph.create(context)!;
    const a = document.createElement('audio');
    const b = document.createElement('audio');
    g.route(a);
    g.route(b);
    const until = g.crossfade(a, b, 1, 0.8, 0.02);
    expect(until).toBeCloseTo(0.04, 9);
    g.setLevel(b, 0.3); // ignored: the cross-fade takes it to 0.8
    (context as { currentTime: number }).currentTime = 0.05;
    g.setLevel(b, 0.3);
    g.setDelay(b, 0.021);
    expect(g.delayOf(b)).toBeCloseTo(0.021, 9);
  });

  it('isn’t made without what it needs, nor routes into a context that isn’t running', () => {
    expect(JoinGraph.create({} as AudioContext)).toBeNull();
    const { context } = fakeContext(() => new Float32Array(0), () => new Float32Array(0));
    (context as { state: string }).state = 'suspended';
    expect(JoinGraph.create(context)!.route(document.createElement('audio'))).toBe(false);
  });
});

describe('measuring through a steady bass line', () => {
  it('finds the right cycle where a bass note repeats many times within the range, and won’t guess on a pure tone', () => {
    // Between kicks: mostly the 55 Hz bass (a cycle every 873 samples), with hats.
    expect(measureLag(sound(12288, 200_000), sound(12288, 201_037), 2880)).toMatchObject({ lag: 1037 });
    const tone = (from: number) => Float32Array.from({ length: 12288 }, (_, i) => Math.sin((2 * Math.PI * 440 * (i + from)) / RATE));
    expect(measureLag(tone(0), tone(500), 2880)).toBeNull();
  });
});

describe('a wide search', () => {
  it('finds a follower a quarter of a second ahead or behind', () => {
    for (const lag of [12_000, -9_000, 5]) {
      expect(measureLag(sound(8192 + 2 * 14_400 + 1, 300_000), sound(8192 + 2 * 14_400 + 1, 300_000 + lag), 14_400), `lag ${lag}`).toMatchObject({ lag });
    }
  });
});
