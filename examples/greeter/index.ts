/**
 * Greeter Adapter - TypeScript port of the Go example.
 * 
 * This is the simplest possible adapter that accepts a "name" config
 * and returns a greeting.
 * 
 * To build:
 *   bun build --compile --target=bun-linux-x64 index.ts --outfile criteria-adapter-greeter
 * 
 * To install:
 *   cp criteria-adapter-greeter ~/.criteria/plugins/
 *   chmod +x ~/.criteria/plugins/criteria-adapter-greeter
 * 
 * Then use in a workflow:
 *   step "greet" {
 *     adapter = "greeter"
 *     input { name = "world" }
 *     outcome "success" { transition_to = "done" }
 *   }
 */

import { serve } from '@criteria/adapter-sdk';

serve({
  name: 'greeter',
  version: '0.1.0',
  capabilities: [],
  
  async execute(req, sender) {
    // Get the name from config, default to 'world'
    const name = req.config.name || 'world';
    const greeting = `hello, ${name}`;
    
    // Emit the greeting as a log line
    await sender.log('stdout', greeting + '\n');
    
    // Return the greeting as a named output
    await sender.result('success', { greeting });
  },
});
