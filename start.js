#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function log(message, color = 'white') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60) + '\n');
}

function logStep(step, message) {
  log(`[${step}] ${message}`, 'blue');
}

function logSuccess(message) {
  log(`✓ ${message}`, 'green');
}

function logError(message) {
  log(`✗ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠ ${message}`, 'yellow');
}

function isDockerEnvironment() {
  if (process.env.DOCKER_CONTAINER === 'true') {
    return true;
  }

  if (fs.existsSync('/.dockerenv')) {
    return true;
  }

  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    if (cgroup.includes('docker') || cgroup.includes('kubepods')) {
      return true;
    }
  } catch (e) {
  }

  return false;
}

function isWindows() {
  return process.platform === 'win32';
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getNpmCommand() {
  return isWindows() ? 'npm.cmd' : 'npm';
}

function getNodeCommand() {
  return 'node';
}

async function executeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const cwd = options.cwd || __dirname;
    const env = { ...process.env, ...options.env };

    logStep('EXEC', `Running: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: isWindows(),
      cwd,
      env,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`));
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start command: ${error.message}`));
    });
  });
}

function generateJWTSecret() {
  return crypto.randomBytes(64).toString('hex');
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyEnvFile(sourcePath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(sourcePath, targetPath);
    return true;
  }
  return false;
}

function updateEnvFile(envPath, key, value) {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  const lines = content.split('\n');
  let found = false;
  const updatedLines = lines.map(line => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updatedLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, updatedLines.join('\n'));
}

function checkEnvFileExists(envPath) {
  return fs.existsSync(envPath);
}

async function setupEnvironmentFiles() {
  logSection('Setting Up Environment Files');

  const envConfigs = [
    {
      name: 'Backend',
      examplePath: path.join(__dirname, 'backend', '.env.example'),
      targetPath: path.join(__dirname, 'backend', '.env'),
    },
    {
      name: 'Frontend',
      examplePath: path.join(__dirname, 'frontend', '.env.example'),
      targetPath: path.join(__dirname, 'frontend', '.env'),
    },
  ];

  for (const config of envConfigs) {
    if (!fs.existsSync(config.examplePath)) {
      logWarning(`Example file not found for ${config.name}: ${config.examplePath}`);
      continue;
    }

    const envExists = checkEnvFileExists(config.targetPath);

    if (!envExists) {
      logStep('CREATE', `Creating .env file for ${config.name}...`);
      copyEnvFile(config.examplePath, config.targetPath);
      logSuccess(`Created .env file for ${config.name}`);
    } else {
      logStep('CHECK', `.env file already exists for ${config.name}`);
    }

    if (config.name === 'Backend') {
      const jwtSecret = generateJWTSecret();
      updateEnvFile(config.targetPath, 'JWT_SECRET', jwtSecret);
      logSuccess(`Generated and set JWT_SECRET for ${config.name}`);
      
      const csrfSecret = generateJWTSecret();
      updateEnvFile(config.targetPath, 'CSRF_SECRET', csrfSecret);
      logSuccess(`Generated and set CSRF_SECRET for ${config.name}`);
    }
  }

  logSuccess('Environment files setup completed');
}

async function initializeDatabase() {
  logSection('Initializing Database');

  const backendDir = path.join(__dirname, 'backend');
  const dataDir = path.join(backendDir, 'data');

  ensureDirectoryExists(dataDir);

  const dbFile = path.join(dataDir, 'mindmap.db');
  const dbExists = fs.existsSync(dbFile);

  if (dbExists) {
    logStep('CHECK', 'Database file already exists');

    if (isProduction() || isDockerEnvironment()) {
      logStep('INFO', 'Checking database schema...');
      
      if (!fs.existsSync(dbFile)) {
          logWarning('Database file not found, cannot verify schema');
        } else {
          try {
            await executeCommand(getNpmCommand(), ['run', 'db:init'], { cwd: backendDir });
            logSuccess('Database schema verified');
          } catch (error) {
            logWarning(`Database schema check failed: ${error.message}`);
          }
        }
    } else {
      logStep('SKIP', 'Database initialization skipped');
    }

    return;
  }

  logStep('INIT', 'Initializing database...');

  try {
    const backendDir = path.join(__dirname, 'backend');
    const dataDir = path.join(backendDir, 'data');
    const dbFile = path.join(dataDir, 'mindmap.db');

    ensureDirectoryExists(dataDir);

    if (!fs.existsSync(dbFile)) {
      logStep('CREATE', 'Creating new database file...');

      const { default: initSqlJs } = await import('sql.js');
      const SQL = await initSqlJs();
      const db = new SQL.Database();
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(dbFile, buffer);
      db.close();

      logSuccess('Database file created');
    }

    logSuccess('Database initialized successfully');
  } catch (error) {
    logError(`Failed to initialize database: ${error.message}`);
    throw error;
  }
}

async function startBackend() {
  logSection('Starting Backend');

  const backendDir = path.join(__dirname, 'backend');

  try {
    let command, args;

    if (isProduction() || isDockerEnvironment()) {
      logStep('START', 'Starting backend in production mode...');

      const distPath = path.join(backendDir, 'dist', 'index.js');
      if (!fs.existsSync(distPath)) {
        logError('Backend dist/index.js not found. Please build the backend first.');
        logStep('HINT', 'Run: npm run build:backend');
        throw new Error('Backend build not found');
      }

      command = getNodeCommand();
      args = ['dist/index.js'];
    } else {
      logStep('START', 'Starting backend in development mode...');
      command = getNpmCommand();
      args = ['run', 'dev'];
    }

    const backendProcess = spawn(command, args, {
      cwd: backendDir,
      stdio: 'inherit',
      shell: isWindows(),
      env: {
        ...process.env,
        NODE_ENV: isProduction() || isDockerEnvironment() ? 'production' : 'development',
      },
    });

    backendProcess.on('error', (error) => {
      logError(`Backend process error: ${error.message}`);
      throw error;
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 5000);

      backendProcess.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      backendProcess.once('exit', (code, signal) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Backend process exited with code ${code}`));
        }
      });
    });

    logSuccess(`Backend started (PID: ${backendProcess.pid})`);
    return backendProcess;
  } catch (error) {
    logError(`Failed to start backend: ${error.message}`);
    throw error;
  }
}

async function startFrontend() {
  logSection('Starting Frontend');

  const frontendDir = path.join(__dirname, 'frontend');

  try {
    if (isProduction() || isDockerEnvironment()) {
      logStep('CHECK', 'Frontend is served statically by backend in production');
      logStep('INFO', 'To rebuild frontend, run: npm run build:frontend');
      return null;
    } else {
      logStep('START', 'Starting frontend in development mode...');

      const frontendProcess = spawn(getNpmCommand(), ['run', 'dev'], {
        cwd: frontendDir,
        stdio: 'inherit',
        shell: isWindows(),
        env: process.env,
      });

      frontendProcess.on('error', (error) => {
        logError(`Frontend process error: ${error.message}`);
        throw error;
      });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 5000);

        frontendProcess.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        frontendProcess.once('exit', (code, signal) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout);
            reject(new Error(`Frontend process exited with code ${code}`));
          }
        });
      });

      logSuccess(`Frontend started (PID: ${frontendProcess.pid})`);
      return frontendProcess;
    }
  } catch (error) {
    logError(`Failed to start frontend: ${error.message}`);
    throw error;
  }
}

async function startServers() {
  logSection('Starting Servers');

  const processes = [];

  try {
    const backendProcess = await startBackend();
    if (backendProcess) {
      processes.push({ name: 'Backend', process: backendProcess });
    }

    const frontendProcess = await startFrontend();
    if (frontendProcess) {
      processes.push({ name: 'Frontend', process: frontendProcess });
    }

    logSuccess('Servers started successfully');

    console.log('\n' + '='.repeat(60));
    log('Running Processes:', 'cyan');
    console.log('='.repeat(60));
    processes.forEach(p => {
      log(`  - ${p.name}: PID ${p.process.pid}`, 'green');
    });
    console.log('='.repeat(60) + '\n');

    return processes;
  } catch (error) {
    logError(`Failed to start servers: ${error.message}`);
    processes.forEach(p => p.process.kill());
    throw error;
  }
}

function getShutdownSignal() {
  if (isWindows()) {
    return 'SIGINT';
  }
  return 'SIGTERM';
}

function handleShutdown(processes) {
  const isShuttingDown = { value: false };

  const shutdown = async (signal) => {
    if (isShuttingDown.value) {
      logWarning('Shutdown already in progress, ignoring signal');
      return;
    }

    isShuttingDown.value = true;
    logSection(`Received ${signal}, shutting down...`);

    const shutdownPromises = processes.map(async (p) => {
      return new Promise((resolve) => {
        try {
          logStep('STOP', `Stopping ${p.name} (PID: ${p.process.pid})...`);

          const killSignal = isWindows() ? 'SIGINT' : signal;

          p.process.kill(killSignal);

          const timeout = setTimeout(() => {
            if (!p.process.killed) {
              logWarning(`Force killing ${p.name} (PID: ${p.process.pid})...`);
              p.process.kill('SIGKILL');
            }
            resolve();
          }, 5000);

          p.process.once('exit', () => {
            clearTimeout(timeout);
            logSuccess(`${p.name} stopped`);
            resolve();
          });
        } catch (error) {
          logWarning(`Error stopping ${p.name}: ${error.message}`);
          resolve();
        }
      });
    });

    await Promise.all(shutdownPromises);

    logSuccess('All processes stopped');
    process.exit(0);
  };

  if (isWindows()) {
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('exit', () => {
      if (!isShuttingDown.value) {
        logWarning('Process exiting without proper shutdown');
      }
    });
  } else {
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
  }

  process.on('uncaughtException', (error) => {
    logError(`Uncaught Exception: ${error.message}`);
    console.error(error);
    shutdown('SIGTERM');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logError(`Unhandled Rejection at: ${promise}`);
    console.error(reason);
    shutdown('SIGTERM');
  });
}

function printUsage() {
  const environmentInfo = `
 Environment Information:
   Docker:        ${isDockerEnvironment() ? 'Yes' : 'No'}
   Production:    ${isProduction() ? 'Yes' : 'No'}
   Platform:      ${process.platform}
   Node Version:  ${process.version}
`;

  console.log(`
╔════════════════════════════════════════════════════════════╗
║           MindMap Application - Startup Script            ╚════════════════════════════════════════════════════════════╝

 Usage:
   node start.js [options]

 Options:
   --env-only        Setup environment files only
   --db-only         Initialize database only
   --start-only      Start servers only (skip setup)
   --production      Run in production mode
   --help, -h        Show this help message

 Examples:
   node start.js               Full setup and start (development)
   node start.js --production  Production setup and start
   node start.js --env-only    Setup environment files only
   node start.js --db-only     Initialize database only
   node start.js --start-only  Start servers without setup

 Notes:
   - Docker environment is automatically detected
   - Production mode builds both frontend and backend
   - Use --start-only to skip setup steps
   - Database is initialized automatically if not exists

${environmentInfo}
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const envOnly = args.includes('--env-only');
  const dbOnly = args.includes('--db-only');
  const startOnly = args.includes('--start-only');
  const productionMode = args.includes('--production') || isProduction();

  const isDocker = isDockerEnvironment();
  const environment = isDocker ? 'Docker' : (productionMode ? 'Production' : 'Development');

  console.log('\n' + '='.repeat(60));
  log('MindMap Application Starter', 'magenta');
  console.log('='.repeat(60));
  log(`Environment: ${environment}`, 'cyan');
  log(`Platform: ${process.platform}`, 'cyan');
  log(`Node Version: ${process.version}`, 'cyan');
  log(`Working Directory: ${process.cwd()}`, 'cyan');
  console.log('='.repeat(60) + '\n');

  try {
    if (envOnly) {
      await setupEnvironmentFiles();
      logSuccess('Environment files configured.');
      process.exit(0);
    }

    if (dbOnly) {
      await initializeDatabase();
      logSuccess('Database initialized.');
      process.exit(0);
    }

    if (startOnly) {
      if (isDocker || productionMode) {
        logStep('CHECK', 'Ensuring database is initialized...');
        await initializeDatabase();
      }

      const processes = await startServers();
      handleShutdown(processes);
      return;
    }

    await setupEnvironmentFiles();
    await initializeDatabase();
    const processes = await startServers();
    handleShutdown(processes);

  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    console.error(error);

    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }

    process.exit(1);
  }
}

main();
