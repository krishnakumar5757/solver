#!/usr/bin/env node
/**
 * NeoSolver service entry point.
 *
 *   neosolver serve      start the HTTP service (default)
 *   neosolver --help     usage
 *   neosolver --version  version
 */

import process from 'node:process';
import os from 'node:os';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';

import { loadConfig, ConfigError, ConfigValueError, describeConfig } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { createLogger } from '../src/log.mjs';

// Automatically load neosolver.env or .env if present (supports Windows and direct node invocations)
if (typeof process.loadEnvFile === 'function') {
  for (const envFile of ['neosolver.env', '.env']) {
    try {
      if (fs.existsSync(envFile)) {
        process.loadEnvFile(envFile);
      }
    } catch {
      /* ignore */
    }
  }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `NeoSolver ${pkg.version} — terminal-only challenge solver service

Usage:
  neosolver serve        Start the HTTP service (default)
  neosolver --check-config
                         Validate the environment and print a redacted summary
  neosolver --help       Show this help
  neosolver --version    Print the version

The service holds your provider credentials and answers a single endpoint:
send the challenge test file in the request body and get the solution files
back as a self-verifying POSIX shell script.

Client (typed inside the challenge terminal — nothing is created there):
  curl -s https://<YOUR-DOMAIN>/s/neo -T tests.js | sh
  curl -s https://<YOUR-DOMAIN> -T tests.js | sh     # only with NEOSOLVER_ALLOW_ANON=1

  Never use \`curl -d @tests.js\`: -d strips newlines and corrupts the file.

Required environment variables (see neosolver.env.example):
  NEOSOLVER_TOKEN          short token you choose (e.g. myteam7); not required when
                           NEOSOLVER_ALLOW_ANON=1 disables client auth
  NEOSOLVER_PROVIDER_URL   OpenAI-compatible base, domain, or full /v1/chat/completions URL
  NEOSOLVER_MODEL          default model id
  NEOSOLVER_PROVIDER_KEY   provider API key. Resolved from, in order:
                             NEOSOLVER_PROVIDER_KEY
                             NEOSOLVER_PROVIDER_KEY_FILE (file holding the raw key)
                           Never logged, never returned in any response.

Optional: NEOSOLVER_ALLOWED_MODELS, NEOSOLVER_REASONING_EFFORT (low|medium|high),
NEOSOLVER_HOST (default 127.0.0.1), NEOSOLVER_PORT (default 8787),
NEOSOLVER_MAX_BODY (1048576), NEOSOLVER_TIMEOUT_MS (120000),
NEOSOLVER_MAX_FILES (64), NEOSOLVER_MAX_TOTAL_BYTES (4194304),
NEOSOLVER_TEST_COMMAND (npm test), NEOSOLVER_LOG_LEVEL (info),
NEOSOLVER_PIDFILE, NEOSOLVER_FALLBACK_MODEL (empty disables the fallback),
NEOSOLVER_MAX_CONCURRENCY (8), NEOSOLVER_QUEUE_LIMIT (32),
NEOSOLVER_LOG_FILE (empty = stderr only), NEOSOLVER_LOG_MAX_BYTES (5242880).
`;

function firstFreePortHint(error) {
  return error?.code === 'EADDRINUSE'
    ? `port ${error.port ?? '?'} is already in use — is another NeoSolver already running? (try ./start.sh status)`
    : null;
}

function pickLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/** Optional pidfile (used by start.sh so `stop`/`status` can find the service). */
function pidfileManager() {
  const path = process.env.NEOSOLVER_PIDFILE;
  if (!path) return { write() {}, remove() {} };
  return {
    write() {
      try {
        fs.writeFileSync(path, `${process.pid}\n`);
      } catch (error) {
        process.stderr.write(`neosolver: could not write pidfile ${path}: ${error.message}\n`);
      }
    },
    remove() {
      try {
        if (fs.existsSync(path) && fs.readFileSync(path, 'utf8').trim() === String(process.pid)) {
          fs.unlinkSync(path);
        }
      } catch {
        /* best effort */
      }
    },
  };
}

async function serve() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ConfigValueError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const log = createLogger({
    level: config.logLevel,
    // Only the provider key is a secret. The client token is the operator's own
    // short passphrase and is deliberately shown in the startup one-liner.
    secrets: [config.providerKey],
    // A bounded file sink: the service owns its log and rotates to <file>.1, so
    // an unattended run cannot fill the disk.
    filePath: config.logFile,
    fileMaxBytes: config.logMaxBytes,
  });

  const pidfile = pidfileManager();
  const server = createServer(config, { logger: log });

  server.on('error', (error) => {
    log.error('server error', { detail: error.message });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.listen(config.port, config.host);
    });
  } catch (error) {
    const hint = firstFreePortHint(error);
    process.stderr.write(hint ? `neosolver: ${hint}\n` : `neosolver: could not start: ${error.message}\n`);
    pidfile.remove();
    process.exit(1);
  }

  pidfile.write();

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const localUrl = `http://127.0.0.1:${port}`;
  const lan = pickLanAddress();
  const lanUrl = lan ? `http://${lan}:${port}` : null;
  const clientHost = lanUrl ?? localUrl;

  log.info(`NeoSolver ${pkg.version} listening on ${config.host}:${port}`);
  for (const [key, value] of Object.entries(describeConfig(config))) {
    log.info(`  ${key}: ${value}`);
  }
  log.info(`  local URL: ${localUrl}`);
  if (lanUrl) log.info(`  LAN URL:   ${lanUrl}`);
  log.info(`  health:    ${localUrl}/healthz`);

  if (config.allowAnon) {
    log.warn(
      'NEOSOLVER_ALLOW_ANON=1 — CLIENT AUTHENTICATION IS DISABLED. ' +
        'Anyone who can reach this port can spend your provider credits. ' +
        'Only run this way behind a reverse proxy with its own access control.',
    );
    log.info(`  client:    curl -s ${clientHost} -T tests.js | sh`);
  } else {
    log.info(`  token:     ${config.token} (chosen by the operator — short is fine)`);
    log.info(`  client:    curl -s ${clientHost}/s/${config.token} -T tests.js | sh`);
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}; shutting down`);
    const force = setTimeout(() => {
      log.warn('shutdown timed out; exiting');
      pidfile.remove();
      process.exit(0);
    }, 5000);
    force.unref();
    server.close(() => {
      pidfile.remove();
      log.info('stopped');
      log.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { detail: error?.stack ?? String(error) });
    pidfile.remove();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { detail: reason?.stack ?? String(reason) });
  });
}

const argv = process.argv.slice(2);

if (argv.includes('--check-config')) {
  try {
    const config = loadConfig();
    for (const [key, value] of Object.entries(describeConfig(config))) {
      process.stdout.write(`${key}: ${value}\n`);
    }
    process.stdout.write('configuration OK\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const command = argv.find((argument) => !argument.startsWith('-')) ?? 'serve';
if (command !== 'serve') {
  process.stderr.write(`neosolver: unknown command "${command}"\n\n${HELP}`);
  process.exit(2);
}

await serve();
