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
  return fs.existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
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

async function executeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      cwd: options.cwd || __dirname,
      env: { ...process.env, ...options.env },
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function executeCommandWithOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errorOutput = '';

    const child = spawn(command, args, {
      shell: true,
      cwd: options.cwd || __dirname,
      env: { ...process.env, ...options.env },
    });

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${errorOutput}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
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

function checkNodeModulesExists(dir) {
  return fs.existsSync(path.join(dir, 'node_modules'));
}

async function installDependencies() {
  logSection('Installing Dependencies');

  const dirs = ['.', 'backend', 'frontend'];

  for (const dir of dirs) {
    const dirPath = path.join(__dirname, dir);
    const nodeModulesPath = path.join(dirPath, 'node_modules');

    if (checkNodeModulesExists(dirPath)) {
      logStep('SKIP', `Dependencies already installed in ${dir || 'root'}`);
      continue;
    }

    logStep('INSTALL', `Installing dependencies in ${dir || 'root'}...`);

    try {
      await executeCommand(getNpmCommand(), ['install'], { cwd: dirPath });
      logSuccess(`Dependencies installed in ${dir || 'root'}`);
    } catch (error) {
      logError(`Failed to install dependencies in ${dir || 'root'}: ${error.message}`);
      throw error;
    }
  }

  logSuccess('All dependencies installed successfully');
}

async function setupEnvironmentFiles() {
  logSection('Setting Up Environment Files');

  const envConfigs = [
    {
      name: 'Root',
      examplePath: path.join(__dirname, '.env.example'),
      targetPath: path.join(__dirname, '.env'),
    },
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
    logStep('SKIP', 'Database initialization skipped');
    return;
  }

  logStep('INIT', 'Initializing database...');

  try {
    await executeCommand('npm', ['run', 'db:init'], { cwd: backendDir });
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
    if (isProduction() || isDockerEnvironment()) {
      logStep('START', 'Starting backend in production mode...');
      const backendProcess = spawn('node', ['dist/index.js'], {
        cwd: backendDir,
        stdio: 'inherit',
        shell: true,
        env: process.env,
      });

      backendProcess.on('error', (error) => {
        logError(`Backend process error: ${error.message}`);
        throw error;
      });

      return backendProcess;
    } else {
      logStep('START', 'Starting backend in development mode...');
      const backendProcess = spawn(getNpmCommand(), ['run', 'dev'], {
        cwd: backendDir,
        stdio: 'inherit',
        shell: true,
        env: process.env,
      });

      backendProcess.on('error', (error) => {
        logError(`Backend process error: ${error.message}`);
        throw error;
      });

      return backendProcess;
    }
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
      logStep('CHECK', 'Frontend should be served statically in production');
      logStep('INFO', 'Frontend build is handled by the backend');
      return null;
    } else {
      logStep('START', 'Starting frontend in development mode...');
      const frontendProcess = spawn(getNpmCommand(), ['run', 'dev'], {
        cwd: frontendDir,
        stdio: 'inherit',
        shell: true,
        env: process.env,
      });

      frontendProcess.on('error', (error) => {
        logError(`Frontend process error: ${error.message}`);
        throw error;
      });

      return frontendProcess;
    }
  } catch (error) {
    logError(`Failed to start frontend: ${error.message}`);
    throw error;
  }
}

async function buildFrontend() {
  logSection('Building Frontend');

  const frontendDir = path.join(__dirname, 'frontend');

  try {
    logStep('BUILD', 'Building frontend...');
    await executeCommand('npm', ['run', 'build'], { cwd: frontendDir });
    logSuccess('Frontend built successfully');
  } catch (error) {
    logError(`Failed to build frontend: ${error.message}`);
    throw error;
  }
}

async function buildBackend() {
  logSection('Building Backend');

  const backendDir = path.join(__dirname, 'backend');

  try {
    logStep('BUILD', 'Building backend...');
    await executeCommand(getNpmCommand(), ['run', 'build'], { cwd: backendDir });
    logSuccess('Backend built successfully');
  } catch (error) {
    logError(`Failed to build backend: ${error.message}`);
    throw error;
  }
}

async function runProductionSetup() {
  logSection('Production Setup');

  await installDependencies();
  await setupEnvironmentFiles();
  await initializeDatabase();
  await buildFrontend();
  await buildBackend();

  logSuccess('Production setup completed');
}

async function runDevelopmentSetup() {
  logSection('Development Setup');

  await installDependencies();
  await setupEnvironmentFiles();
  await initializeDatabase();

  logSuccess('Development setup completed');
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

function handleShutdown(processes) {
  const shutdown = async (signal) => {
    logSection(`Received ${signal}, shutting down...`);

    processes.forEach(p => {
      logStep('STOP', `Stopping ${p.name}...`);
      p.process.kill(signal);
    });

    setTimeout(() => {
      processes.forEach(p => {
        if (!p.process.killed) {
          p.process.kill('SIGKILL');
        }
      });
      process.exit(0);
    }, 5000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printUsage() {
  console.log(`
Usage: node start.js [options]

Options:
  --install-only       Install dependencies only
  --env-only           Setup environment files only
  --db-only            Initialize database only
  --build-only         Build frontend and backend only
  --start-only         Start servers only (skip setup)
  --production         Run in production mode
  --help, -h           Show this help message

Examples:
  node start.js                    Full setup and start (development)
  node start.js --production       Production setup and start
  node start.js --install-only     Install dependencies only
  node start.js --start-only       Start servers without setup
  node start.js --build-only       Build only (for production)
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const installOnly = args.includes('--install-only');
  const envOnly = args.includes('--env-only');
  const dbOnly = args.includes('--db-only');
  const buildOnly = args.includes('--build-only');
  const startOnly = args.includes('--start-only');
  const productionMode = args.includes('--production') || isProduction();

  console.log('\n' + '='.repeat(60));
  log('MindMap Application Starter', 'magenta');
  console.log('='.repeat(60));
  log(`Environment: ${isDockerEnvironment() ? 'Docker' : (productionMode ? 'Production' : 'Development')}`, 'cyan');
  log(`Platform: ${process.platform}`, 'cyan');
  console.log('='.repeat(60) + '\n');

  try {
    if (installOnly) {
      await installDependencies();
      process.exit(0);
    }

    if (envOnly) {
      await setupEnvironmentFiles();
      process.exit(0);
    }

    if (dbOnly) {
      await initializeDatabase();
      process.exit(0);
    }

    if (buildOnly) {
      await runProductionSetup();
      process.exit(0);
    }

    if (startOnly) {
      const processes = await startServers();
      handleShutdown(processes);
      return;
    }

    if (productionMode || isDockerEnvironment()) {
      await runProductionSetup();
      const processes = await startServers();
      handleShutdown(processes);
    } else {
      await runDevelopmentSetup();
      const processes = await startServers();
      handleShutdown(processes);
    }

  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
