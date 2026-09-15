import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const addresses = Object.entries(networkInterfaces())
  .filter(([name]) => !/^(utun|tun|tap|docker|veth|bridge)/.test(name))
  .flatMap(([, interfaces]) => interfaces ?? [])
  .filter((address) => address.family === 'IPv4' && !address.internal);
const host =
  addresses.find((address) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))
    ?.address ?? 'localhost';
const token = randomBytes(32).toString('hex');
const env = [
  'OPENAI_API_KEY=',
  `API_TOKEN=${token}`,
  `EXPO_PUBLIC_API_TOKEN=${token}`,
  `EXPO_PUBLIC_API_URL=http://${host}:8088`,
  '',
].join('\n');

try {
  await writeFile(resolve('.env.local'), env, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.local. Add your OpenAI key to OPENAI_API_KEY.');
  console.log('Check EXPO_PUBLIC_API_URL uses the address your phone can reach.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env.local already exists. It was not changed.');
}
