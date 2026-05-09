/**
 * @criteria/adapter-sdk
 * 
 * TypeScript SDK for building Criteria adapter plugins. This SDK enables you to write out-of-process adapter plugins for the Criteria
 * workflow engine using TypeScript, with Bun compilation for native binary distribution via OCI.
 * 
 * ## Quick Start
 * 
 * ```typescript
 * import { serve } from '@criteria/adapter-sdk';
 * 
 * serve({
 *   name: 'my-adapter',
 *   version: '1.0.0',
 *   
 *   async execute(req, sender) {
 *     // Log output
 *     await sender.log('stdout', 'Processing...\n');
 *     
 *     // Access config from workflow
 *     const name = req.config.name || 'world';
 *     
 *     // Return outcome and outputs
 *     await sender.result('success', { 
 *       greeting: `Hello, ${name}!` 
 *     });
 *   },
 * });
 * ```
 * 
 * ## Building
 * 
 * Compile your adapter to a native binary:
 * 
 * ```bash
 * bun build --compile adapter.ts --outfile criteria-adapter-mine
 * ```
 * 
 * ## Distribution
 * 
 * Package as an OCI artifact:
 * 
 * ```bash
 * for target in bun-linux-x64 bun-linux-arm64 bun-darwin-arm64; do
 *   bun build --compile --target=$target adapter.ts --outfile criteria-adapter-mine-$target
done
 * ```
 */

// Re-export everything from the plugin module
export * from './plugin/index.js';

// Version constant — matches criteria SDK v0.3.0
export const SDK_VERSION = '0.3.0';
