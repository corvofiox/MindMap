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

function generateSensitiveConfig() {
  return {
    JWT_SECRET: crypto.randomBytes(32).toString('base64'),
  };
}

async function generateEnvFile(envExamplePath, envPath, generateSecrets = false) {
  if (fs.existsSync(envPath)) {
    log(`Environment file already exists: ${path.basename(envPath)}`, 'yellow');
    return false;
  }

  if (!fs.existsSync(envExamplePath)) {
    throw new Error(`Environment template not found: ${envExamplePath}`);
  }

  const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');
  
  const exampleConfig = envExampleContent
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .reduce((config, line) => {
      const [key, ...valueParts] = line.split('=');
      if (key) {
        config[key.trim()] = valueParts.join('=').trim();
      }
      return config;
    }, {});

  let finalConfig = { ...exampleConfig };

  if (generateSecrets) {
    const sensitiveConfig = generateSensitiveConfig();
    finalConfig = { ...finalConfig, ...sensitiveConfig };
    log(`Generated secure keys: ${Object.keys(sensitiveConfig).join(', ')}`, 'green');
  }

  finalConfig.NODE_ENV = process.env.NODE_ENV || 'development';

  const envContent = Object.entries(finalConfig)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  fs.writeFileSync(envPath, envContent, 'utf8');
  log(`Environment file generated: ${path.basename(envPath)}`, 'green');
  
  return true;
}

async function checkNodeVersion() {
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
  
  logStep('Node', `Version: ${nodeVersion}`);
  
  if (majorVersion < 18) {
    log('Warning: Node.js version is below v18. Some features may not work.', 'yellow');
  }
}

async function checkPlatformSupport() {
  const platform = process.platform;
  logStep('Platform', platform);
  
  if (platform === 'win32') {
    log('Note: On Windows, use PowerShell or WSL for best results', 'yellow');
  }
}

async function generateEnvironmentFiles() {
  logSection('Environment Configuration');
  
  const backendEnvGenerated = await generateEnvFile(
    path.join(__dirname, 'backend', '.env.example'),
    path.join(__dirname, 'backend', '.env'),
    true
  );
  
  const frontendEnvGenerated = await generateEnvFile(
    path.join(__dirname, 'frontend', '.env.example'),
    path.join(__dirname, 'frontend', '.env'),
    false
  );
  
  if (!backendEnvGenerated && !frontendEnvGenerated) {
    log('All environment files already exist', 'yellow');
  }
}

async function installDependencies() {
  logSection('Dependencies');
  
  logStep('Root', 'Installing...');
  await executeCommand('npm', ['install']);
  
  logStep('Workspaces', 'Installing...');
  await executeCommand('npm', ['install', '--workspaces']);
  
  log('All dependencies installed', 'green');
}

async function initializeDatabase() {
  logSection('Database');
  
  const dbInitScript = path.join(__dirname, 'backend', 'scripts', 'init-db.js');
  
  if (fs.existsSync(dbInitScript)) {
    logStep('Init', 'Running database initialization...');
    await executeCommand('node', [dbInitScript], { cwd: path.join(__dirname, 'backend') });
  } else {
    logStep('Init', 'No initialization script found, using npm run db:init');
    await executeCommand('npm', ['run', 'db:init'], { cwd: path.join(__dirname, 'backend') });
  }
  
  log('Database initialized', 'green');
}

async function startBackendServer() {
  return new Promise((resolve, reject) => {
    const backendProcess = spawn('npm', ['run', 'dev'], {
      cwd: path.join(__dirname, 'backend'),
      stdio: 'pipe',
      shell: true,
    });

    backendProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Listening on') || output.includes('Server running')) {
        log('Backend server started', 'green');
        resolve(backendProcess);
      }
    });

    backendProcess.stderr.on('data', (data) => {
      console.error(`Backend: ${data}`);
    });

    backendProcess.on('error', (error) => {
      reject(error);
    });

    backendProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        log(`Backend process exited with code ${code}`, 'red');
      }
    });

    setTimeout(() => {
      log('Backend server starting...', 'yellow');
      resolve(backendProcess);
    }, 5000);
  });
}

async function startFrontendServer() {
  return new Promise((resolve, reject) => {
    const frontendProcess = spawn('npm', ['run', 'dev'], {
      cwd: path.join(__dirname, 'frontend'),
      stdio: 'pipe',
      shell: true,
    });

    frontendProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Local:') || output.includes('ready in')) {
        log('Frontend server started', 'green');
        resolve(frontendProcess);
      }
    });

    frontendProcess.stderr.on('data', (data) => {
      console.error(`Frontend: ${data}`);
    });

    frontendProcess.on('error', (error) => {
      reject(error);
    });

    frontendProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        log(`Frontend process exited with code ${code}`, 'red');
      }
    });

    setTimeout(() => {
      log('Frontend server starting...', 'yellow');
      resolve(frontendProcess);
    }, 5000);
  });
}

async function startDevelopmentServers() {
  logSection('Development Servers');
  
  log('Starting servers...', 'cyan');
  
  let backendProcess;
  let frontendProcess;

  try {
    backendProcess = await startBackendServer();
    frontendProcess = await startFrontendServer();
  } catch (error) {
    throw new Error(`Failed to start servers: ${error.message}`);
  }

  log('\n' + '='.repeat(60));
  log('🚀 MindMap Development Environment Running', 'green');
  log('='.repeat(60));
  log('Backend:  http://localhost:3001', 'green');
  log('Frontend: http://localhost:5173', 'green');
  log('API Docs: http://localhost:3001/api-docs', 'green');
  log('\nPress Ctrl+C to stop all servers', 'cyan');
  log('='.repeat(60) + '\n');

  const cleanup = () => {
    log('\nShutting down servers...', 'yellow');
    if (backendProcess && !backendProcess.killed) {
      backendProcess.kill('SIGTERM');
    }
    if (frontendProcess && !frontendProcess.killed) {
      frontendProcess.kill('SIGTERM');
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return { backendProcess, frontendProcess };
}

async function main() {
  console.clear();
  logSection('MindMap Development Environment');
  
  log(`Working Directory: ${__dirname}`, 'blue');
  log(`Node Version: ${process.version}`, 'blue');
  log(`Platform: ${process.platform}`, 'blue');
  
  const args = process.argv.slice(2);
  const runMode = args[0];
  
  const startTime = Date.now();

  try {
    await checkNodeVersion();
    await checkPlatformSupport();
    
    if (runMode === '--generate-env-only') {
      await generateEnvironmentFiles();
      log(`Environment generation completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`, 'green');
      process.exit(0);
    }
    
    if (runMode === '--install-only') {
      await installDependencies();
      log(`Installation completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`, 'green');
      process.exit(0);
    }
    
    await generateEnvironmentFiles();
    await installDependencies();
    await initializeDatabase();
    await startDevelopmentServers();
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`\nStartup completed in ${elapsed}s`, 'green');
    
  } catch (error) {
    log(`\n❌ Error: ${error.message}`, 'red');
    log(`Stack: ${error.stack}`, 'red');
    process.exit(1);
  }
}

main();
