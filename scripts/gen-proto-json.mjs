/**
 * Generate a protobufjs JSON descriptor for criteria/v2/adapter.proto.
 *
 * The v2 server loads this descriptor via protoLoader.fromJSON() instead of
 * reading the .proto off disk. `bun build --compile` cannot bundle a file that
 * is read at runtime, so a path-based load leaves the compiled adapter binary
 * dependent on a proto/ directory sitting in its working directory.
 *
 * Usage: bun run proto:json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const includeDir = path.join(repoRoot, 'proto');
const entry = 'criteria/v2/adapter.proto';
const outFile = path.join(repoRoot, 'src', 'proto', 'criteria', 'v2', 'adapter.json');

const protobufjsDir = path.dirname(fileURLToPath(import.meta.resolve('protobufjs')));

const root = new protobuf.Root();
// google/protobuf/* come from protobufjs: well-known types (struct, timestamp)
// are built-in "common" definitions; descriptor.proto ships as a file. Anything
// else resolves against the include dir.
root.resolvePath = (_origin, target) => {
  if (protobuf.common[target]) return target;
  if (target.startsWith('google/protobuf/')) return path.join(protobufjsDir, target);
  return path.join(includeDir, target);
};

root.loadSync(entry, { keepCase: false });

const json = JSON.stringify(root.toJSON(), null, 2);
fs.writeFileSync(outFile, json + '\n');
console.log(`wrote ${path.relative(repoRoot, outFile)} (${json.length} bytes)`);
