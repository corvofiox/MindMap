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
  logSection('Module 1: Initialize Environment Files');

  const isDocker = isDockerEnvironment();
  const isProd = isProduction();
  const shouldGenerateSecrets = isDocker || !isProd;

  let envCreated = false;

  // Backend环境文件配置
  // 在Docker/生产环境中，backend从 /app/backend/dist/backend/.env 加载
  // 在开发环境中，从 /app/backend/.env 加载
  const backendDistPath = path.join(__dirname, 'backend', 'dist', 'backend', '.env');
  const backendDevPath = path.join(__dirname, 'backend', '.env');
  const backendExamplePath = path.join(__dirname, 'backend', '.env.example');
  const backendTargetPath = (isDocker || isProd) ? backendDistPath : backendDevPath;

  // Frontend环境文件配置
  const frontendTargetPath = path.join(__dirname, 'frontend', '.env');
  const frontendExamplePath = path.join(__dirname, 'frontend', '.env.example');

  // 处理Backend .env
  if (fs.existsSync(backendExamplePath)) {
    if (!fs.existsSync(backendTargetPath)) {
      logStep('CREATE', `Creating .env file for Backend at ${backendTargetPath}...`);
      ensureDirectoryExists(path.dirname(backendTargetPath));
      copyEnvFile(backendExamplePath, backendTargetPath);
      logSuccess(`Created .env file for Backend`);
      envCreated = true;
    } else {
      logStep('SKIP', `Backend .env file already exists at ${backendTargetPath} - skipping`);
    }

    // 更新Backend环境变量
    // 在 Docker/生产环境中，确保 PORT 从环境变量传递
    if (process.env.PORT) {
      logStep('INFO', `Using PORT from environment variable: ${process.env.PORT}`);
      updateEnvFile(backendTargetPath, 'PORT', process.env.PORT);
    }

    if (process.env.NODE_ENV) {
      logStep('INFO', `Using NODE_ENV from environment variable: ${process.env.NODE_ENV}`);
      updateEnvFile(backendTargetPath, 'NODE_ENV', process.env.NODE_ENV);
    }

    if (process.env.ALLOWED_ORIGINS) {
      logStep('INFO', `Using ALLOWED_ORIGINS from environment variable: ${process.env.ALLOWED_ORIGINS}`);
      updateEnvFile(backendTargetPath, 'ALLOWED_ORIGINS', process.env.ALLOWED_ORIGINS);
    }

    if (process.env.JWT_SECRET) {
      logStep('INFO', 'Using JWT_SECRET from environment variable');
      updateEnvFile(backendTargetPath, 'JWT_SECRET', process.env.JWT_SECRET);
    } else if (shouldGenerateSecrets) {
      const jwtSecret = generateJWTSecret();
      updateEnvFile(backendTargetPath, 'JWT_SECRET', jwtSecret);
      logSuccess(`Generated and set JWT_SECRET for Backend`);
    }

    if (process.env.CSRF_SECRET) {
      logStep('INFO', 'Using CSRF_SECRET from environment variable');
      updateEnvFile(backendTargetPath, 'CSRF_SECRET', process.env.CSRF_SECRET);
    } else if (shouldGenerateSecrets) {
      const csrfSecret = generateJWTSecret();
      updateEnvFile(backendTargetPath, 'CSRF_SECRET', csrfSecret);
      logSuccess(`Generated and set CSRF_SECRET for Backend`);
    }

    // 在Docker/生产环境中，同时创建 /app/backend/.env 作为备份
    if ((isDocker || isProd) && backendTargetPath !== backendDevPath) {
      if (!fs.existsSync(backendDevPath)) {
        ensureDirectoryExists(path.dirname(backendDevPath));
        copyEnvFile(backendTargetPath, backendDevPath);
        logStep('CREATE', `Also created backup .env at ${backendDevPath}`);
      }
    }
  } else {
    logWarning(`Backend .env.example not found: ${backendExamplePath}`);
  }

  // 处理Frontend .env
  if (fs.existsSync(frontendExamplePath)) {
    if (!fs.existsSync(frontendTargetPath)) {
      logStep('CREATE', `Creating .env file for Frontend at ${frontendTargetPath}...`);
      ensureDirectoryExists(path.dirname(frontendTargetPath));
      copyEnvFile(frontendExamplePath, frontendTargetPath);
      logSuccess(`Created .env file for Frontend`);
      envCreated = true;
    } else {
      logStep('SKIP', `Frontend .env file already exists at ${frontendTargetPath} - skipping`);
    }
  } else {
    logWarning(`Frontend .env.example not found: ${frontendExamplePath}`);
  }

  if (!envCreated) {
    logWarning('All environment files already exist - no new files created');
  }

  logSuccess('Environment files module completed');
  return !envCreated;
}

async function initializeDatabase() {
  logSection('Module 2: Initialize Database');

  const backendDir = path.join(__dirname, 'backend');
  const dataDir = path.join(backendDir, 'data');

  ensureDirectoryExists(dataDir);

  const dbFile = path.join(dataDir, 'mindmap.db');
  const dbExists = fs.existsSync(dbFile);

  if (dbExists) {
    logStep('SKIP', 'Database file already exists - skipping initialization');

    if (isProduction() || isDockerEnvironment()) {
      logStep('INFO', 'Production/Docker mode - database will be initialized by backend server');
    } else {
      logStep('INFO', 'Development mode - database initialization skipped');
    }

    return true;
  }

  logStep('INIT', 'Initializing new database...');

  try {
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

    logSuccess('Database module completed');
    return false;
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

      const possiblePaths = [
        path.join(backendDir, 'dist', 'index.js'),
        path.join(backendDir, 'dist', 'backend', 'src', 'index.js'),
      ];

      let distPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          distPath = p;
          break;
        }
      }

      if (!distPath) {
        logError('Backend dist/index.js not found. Please build the backend first.');
        logStep('HINT', 'Run: npm run build:backend');
        throw new Error('Backend build not found');
      }

      command = getNodeCommand();
      args = [path.relative(backendDir, distPath)];
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
  logSection('Module 3: Start Frontend and Backend');

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

    logSuccess('Servers module completed');

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

 Modules:
   Module 1: Initialize Environment Files
   Module 2: Initialize Database
   Module 3: Start Frontend and Backend Servers

 Options:
   --env-only        Run Module 1 only (initialize environment files)
   --db-only         Run Module 2 only (initialize database)
   --start-only      Run Module 3 only (start servers, skip setup)
   --production      Run in production mode
   --help, -h        Show this help message

 Examples:
   node start.js               Full setup and start (development)
   node start.js --production  Production setup and start
   node start.js --env-only    Setup environment files only (Module 1)
   node start.js --db-only     Initialize database only (Module 2)
   node start.js --start-only  Start servers only, skip setup (Module 3)

 Default Behavior:
   Running start.js without options executes all three modules:
   1. Initialize environment files (skips if .env files exist)
   2. Initialize database (skips if database file exists)
   3. Start frontend and backend servers

 Notes:
   - Docker environment is automatically detected
   - Production mode builds both frontend and backend
   - Use --start-only to skip setup steps
   - Database is initialized automatically if not exists
   - Environment files are created if not present

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
      logSuccess('Module 1 (Environment Files) completed.');
      process.exit(0);
    }

    if (dbOnly) {
      await initializeDatabase();
      logSuccess('Module 2 (Database) completed.');
      process.exit(0);
    }

    if (startOnly) {
      logSection('Running Module 3 Only (Start Servers)');
      logWarning('Skipping Module 1 (Environment Files) and Module 2 (Database)');
      logStep('INFO', 'Verifying environment files...');
      await setupEnvironmentFiles();

      logStep('INFO', 'Ensuring database is initialized...');
      await initializeDatabase();

      const processes = await startServers();
      handleShutdown(processes);
      return;
    }

    logSection('Running Full Startup Sequence');
    log('Module 1: Initialize Environment Files', 'cyan');
    log('Module 2: Initialize Database', 'cyan');
    log('Module 3: Start Frontend and Backend', 'cyan');
    console.log('');

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
