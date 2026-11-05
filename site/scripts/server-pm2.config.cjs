// Dedicated PM2 process for the Node server. Never put passwords in this file.
// The operator must select an unused unprivileged port and a persistent data
// directory explicitly. Keeping the listener on loopback avoids accidentally
// exposing a financial application while HTTPS/access policy are unresolved.
const path = require('node:path');

const port = process.env.ALLOCATION_PORT;
const dataDir = process.env.ALLOCATION_DATA_DIR;
const rateKeyFile = process.env.ALLOCATION_RATE_KEY_FILE;
const reviewerATokenFile = process.env.ALLOCATION_REVIEWER_A_TOKEN_FILE;
const reviewerBTokenFile = process.env.ALLOCATION_REVIEWER_B_TOKEN_FILE;
const commitTokenFile = process.env.ALLOCATION_COMMIT_TOKEN_FILE;
const syncTokenFile = process.env.ALLOCATION_SYNC_TOKEN_FILE;
const publicOrigin = process.env.ALLOCATION_PUBLIC_ORIGIN;
if (!/^\d+$/.test(port || '') || Number(port) < 1024 || Number(port) > 65535) {
  throw new Error('Set ALLOCATION_PORT to an unused port in the range 1024–65535.');
}
if (!dataDir || !path.isAbsolute(dataDir)) {
  throw new Error('Set ALLOCATION_DATA_DIR to an absolute persistent directory.');
}
if (!rateKeyFile || !path.isAbsolute(rateKeyFile)
  || !reviewerATokenFile || !path.isAbsolute(reviewerATokenFile)
  || !reviewerBTokenFile || !path.isAbsolute(reviewerBTokenFile)
  || !commitTokenFile || !path.isAbsolute(commitTokenFile)) {
  throw new Error('Set absolute paths for the rate key, separate reviewer A/B tokens, and commit token.');
}
if (!syncTokenFile || !path.isAbsolute(syncTokenFile)) {
  throw new Error('Set an absolute path for the ledger sync token file.');
}
const root = path.resolve(__dirname, '..');
module.exports = {
  apps: [{
    name: 'allocation-web',
    cwd: root,
    script: path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
    args: ['start', '--hostname', '127.0.0.1', '--port', port],
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    kill_timeout: 10000,
    env: { NODE_ENV: 'production', ALLOCATION_DATA_DIR: dataDir, ALLOCATION_RATE_KEY_FILE:rateKeyFile, ALLOCATION_REVIEWER_A_TOKEN_FILE:reviewerATokenFile, ALLOCATION_REVIEWER_B_TOKEN_FILE:reviewerBTokenFile, ALLOCATION_COMMIT_TOKEN_FILE:commitTokenFile, ALLOCATION_SYNC_TOKEN_FILE:syncTokenFile, ...(publicOrigin ? { ALLOCATION_PUBLIC_ORIGIN:publicOrigin } : {}) },
  }],
};
