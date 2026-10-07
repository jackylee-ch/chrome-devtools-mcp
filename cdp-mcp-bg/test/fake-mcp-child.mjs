// Tiny fake downstream MCP-ish server over newline-delimited JSON-RPC (for proxy tests).
// Responds to initialize / tools/list / ping. Prints its own pid so a swap is detectable.
import readline from 'node:readline';
const cloneArg = (process.argv.find(a => a.startsWith('--clone=')) || '').slice('--clone='.length);
const rl = readline.createInterface({input: process.stdin});
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', line => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({jsonrpc: '2.0', id: msg.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fake-mcp', pid: process.pid}}});
  } else if (msg.method === 'tools/list') {
    send({jsonrpc: '2.0', id: msg.id, result: {tools: [{name: 'navigate_page'}, {name: 'take_snapshot'}, {name: 'screenshot'}]}});
  } else if (msg.method === 'ping') {
    if (msg.params && msg.params.emitNote) {
      send({jsonrpc: '2.0', method: 'notifications/message', params: {level: 'info', data: 'hello'}}); // unsolicited notification
    }
    send({jsonrpc: '2.0', id: msg.id, result: {pid: process.pid, clone: cloneArg}});
  } else if (msg.id !== undefined) {
    send({jsonrpc: '2.0', id: msg.id, error: {code: -32601, message: 'method not found'}});
  }
});
