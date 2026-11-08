import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchAt, ProbeError, resolveName, type Resolved } from './probe.ts';
import { TEST_CERT, TEST_HOST, TEST_KEY } from './testCertificate.ts';

const LOCAL: Resolved = { address: '127.0.0.1', family: 4 };
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listening(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket: Socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** HTTPS with the test certificate, answering every GET with `body`. */
const https = (body = '{"answer":"42"}', status = 200) =>
  listening(
    createHttpsServer({ cert: TEST_CERT, key: TEST_KEY }, (req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 302 ? { location: 'https://elsewhere.example/' } : {}) });
      res.end(JSON.stringify({ host: req.headers.host, path: req.url, body: JSON.parse(body) }));
    }),
  );

const failure = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProbeError);
  return err as ProbeError;
};

describe('fetchAt', () => {
  it('asks the address for the URL, by its name, and reads the answer and the certificate', async () => {
    const port = await https();
    const res = await fetchAt(new URL(`https://${TEST_HOST}:${port}/reachable/abc`), LOCAL, 2000, { ca: TEST_CERT });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ host: `${TEST_HOST}:${port}`, path: '/reachable/abc', body: { answer: '42' } });
    expect(res.certificate).toEqual({ issuer: 'Playarr Test', validTo: expect.stringMatching(/^2126-/) });
  });

  it('says where a redirect leads', async () => {
    const port = await https('{}', 302);
    const res = await fetchAt(new URL(`https://${TEST_HOST}:${port}/`), LOCAL, 2000, { ca: TEST_CERT });
    expect(res).toMatchObject({ status: 302, location: 'https://elsewhere.example/' });
  });

  it('fails while connecting when nothing listens', async () => {
    const port = await listening(createTcpServer());
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const err = await failure(fetchAt(new URL(`https://${TEST_HOST}:${port}/`), LOCAL, 2000));
    expect(err).toMatchObject({ phase: 'connect', code: 'ECONNREFUSED' });
  });

  it('fails in the handshake on a certificate no authority vouches for', async () => {
    const port = await https();
    const err = await failure(fetchAt(new URL(`https://${TEST_HOST}:${port}/`), LOCAL, 2000));
    expect(err.phase).toBe('tls');
    expect(err.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('fails in the handshake on a certificate for another name', async () => {
    const port = await https();
    const err = await failure(fetchAt(new URL(`https://other.example.test:${port}/`), LOCAL, 2000, { ca: TEST_CERT }));
    expect(err).toMatchObject({ phase: 'tls', code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });

  it('fails in the handshake when the port speaks plain HTTP', async () => {
    const port = await listening(createTcpServer((socket) => socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')));
    const err = await failure(fetchAt(new URL(`https://${TEST_HOST}:${port}/`), LOCAL, 2000));
    expect(err).toMatchObject({ phase: 'tls', code: 'EPROTO' });
  });

  it('gives up after its time, saying how far it got', async () => {
    // Takes the connection and says nothing.
    const port = await listening(createTcpServer(() => {}));
    const err = await failure(fetchAt(new URL(`https://${TEST_HOST}:${port}/`), LOCAL, 300));
    expect(err).toMatchObject({ phase: 'tls', code: 'ETIMEDOUT' });
  });
});

describe('resolveName', () => {
  it('lists a name’s addresses, IPv4 first', async () => {
    const found = await resolveName('localhost', 2000);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.family === 4 || found.every((a) => a.family === 6)).toBe(true);
  });

  it('fails for a name that doesn’t exist', async () => {
    await expect(resolveName('no-such-name.invalid', 2000)).rejects.toThrow();
  });
});
