import type { AddressInfo, Server } from 'node:net';
import supertest from 'supertest';

// SuperTest starts its own server with `listen(0)`, a dual-stack `[::]`
// wildcard, and then dials `127.0.0.1`. On macOS the kernel will hand that
// wildcard a port another process already holds on `127.0.0.1` itself, and the
// more specific socket wins the IPv4 connection. Under the parallel suite that
// sent requests to another worker's loopback server (a 401 from an
// authenticated one). No other socket can claim `[::1]` on the wildcard's port,
// so dial that instead whenever the server is the IPv6 wildcard.
type ServerAddress = (app: Server, path: string) => string;
const prototype = (supertest as unknown as { Test: { prototype: { serverAddress: ServerAddress } } }).Test.prototype;
const serverAddress = prototype.serverAddress;
prototype.serverAddress = function (app, path) {
  const url = serverAddress.call(this, app, path);
  return (app.address() as AddressInfo | null)?.address === '::' ? url.replace('//127.0.0.1:', '//[::1]:') : url;
};
