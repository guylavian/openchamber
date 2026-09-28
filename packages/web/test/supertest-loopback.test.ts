import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';

const servers: http.Server[] = [];
const listen = (server: http.Server, port: number, host?: string) => new Promise<boolean>((resolve) => {
  servers.push(server);
  server.once('error', () => resolve(false));
  server.listen(port, host, () => resolve(true));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

it('reaches its own wildcard server when another socket holds 127.0.0.1 on the same port', async (context) => {
  const own = http.createServer((_request, response) => response.end('own'));
  await listen(own, 0);
  const { port } = own.address() as AddressInfo;
  const thief = http.createServer((_request, response) => { response.statusCode = 401; response.end('thief'); });
  // Linux refuses this bind, so the collision cannot happen there.
  if (!await listen(thief, port, '127.0.0.1')) context.skip();

  await request(own).get('/').expect(200, 'own');
});
