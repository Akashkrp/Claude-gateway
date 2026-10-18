const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const logFile = path.join(__dirname, 'gateway.log');
const out = fs.openSync(logFile, 'w');

const serverPath = path.join(__dirname, 'server.js');
const child = spawn('node', [serverPath], {
  cwd: __dirname,
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true,
});
child.unref();
console.log('Claude Gateway started silently with PID:', child.pid);
process.exit(0);
