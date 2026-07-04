const { spawn } = require('child_process');
const child = spawn('node', ['./dist/src/index.js', 'serve']);

child.stdout.on('data', (data) => {
  console.log(`STDOUT: ${data}`);
});
child.stderr.on('data', (data) => {
  console.log(`STDERR: ${data}`);
});

child.on('close', (code) => {
  console.log(`child process exited with code ${code}`);
});

// Send initialize request
const initReq = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" }
  }
};
child.stdin.write(JSON.stringify(initReq) + '\n');

setTimeout(() => {
  child.kill();
}, 2000);
