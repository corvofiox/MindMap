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

// B2: .env.example 模板中的示例占位符不算真实密钥——检测到占位符时仍应生成
// 随机密钥覆盖,否则全新部署会带着公开的弱密钥运行。
function isPlaceholderSecret(value) {
  if (!value) return true;
  const v = value.trim();
  // R2-6: 识别 dev 环境模板密钥（backend/.env.development 的
  // dev-jwt-secret-key-for-development-only / dev-csrf-secret-key-for-development-only）——
  // 否则 dev 环境会从"每次启动随机生成"变成"保留公开已知密钥"。
  return v === '' || v.includes('change-me-in-production') || v === 'your-secret-key'
    || (v.startsWith('dev-') && v.includes('key-for-development'));
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
  // 后端 index.ts 通过 dotenv 从 <cwd>/backend/.env 加载（编译后 __dirname 为 backend/dist，向上取一级）
  // 因此无论 Docker/生产还是开发，目标路径都统一为 backend/.env
  const backendTargetPath = path.join(__dirname, 'backend', '.env');
  const backendExamplePath = path.join(__dirname, 'backend', '.env.example');
  const backendDevExamplePath = path.join(__dirname, 'backend', '.env.development');

  // 根据环境选择模板文件
  const backendTemplatePath = (isDocker || isProd) ? backendExamplePath : 
    (fs.existsSync(backendDevExamplePath) ? backendDevExamplePath : backendExamplePath);

  // Frontend环境文件配置
  const frontendTargetPath = path.join(__dirname, 'frontend', '.env');
  const frontendExamplePath = path.join(__dirname, 'frontend', '.env.example');

  // 验证 .env 文件是否包含必要配置
  const REQUIRED_ENV_KEYS = ['PORT', 'NODE_ENV', 'JWT_SECRET', 'CSRF_SECRET'];
  function validateEnvFile(envPath) {
    if (!fs.existsSync(envPath)) return false;
    const content = fs.readFileSync(envPath, 'utf-8');
    return REQUIRED_ENV_KEYS.every(key => {
      const regex = new RegExp(`^${key}=`, 'm');
      return regex.test(content);
    });
  }

  // 处理Backend .env
  if (fs.existsSync(backendTemplatePath)) {
    const envExists = fs.existsSync(backendTargetPath);
    const envValid = envExists && validateEnvFile(backendTargetPath);
    
    if (!envExists || !envValid) {
      if (envExists && !envValid) {
        logWarning(`Backend .env file exists but missing required keys - regenerating`);
      }
      logStep('CREATE', `Creating .env file for Backend at ${backendTargetPath}...`);
      ensureDirectoryExists(path.dirname(backendTargetPath));
      copyEnvFile(backendTemplatePath, backendTargetPath);
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
      // B2: .env 已有非空密钥时保留原值——Docker 容器内 backend/.env 不在
      // 持久卷上,若每次启动都重新生成随机密钥,重建容器会使所有 JWT 会话
      // 失效,且 AI_KEY_SECRET 轮换会导致数据库已存 AI 密钥 AES 解密失败。
      // 固定密钥由 docker-compose environment 注入,或首次生成后保持不变。
      const existingSecret = getEnvValue(backendTargetPath, 'JWT_SECRET');
      if (existingSecret && !isPlaceholderSecret(existingSecret)) {
        logStep('SKIP', `JWT_SECRET already exists in .env - keeping existing value`);
      } else {
        const jwtSecret = generateJWTSecret();
        updateEnvFile(backendTargetPath, 'JWT_SECRET', jwtSecret);
        logSuccess(`Generated and set JWT_SECRET for Backend`);
      }
    }

    if (process.env.CSRF_SECRET) {
      logStep('INFO', 'Using CSRF_SECRET from environment variable');
      updateEnvFile(backendTargetPath, 'CSRF_SECRET', process.env.CSRF_SECRET);
    } else if (shouldGenerateSecrets) {
      // B2: 同 JWT_SECRET——保留已有值,避免容器重建后 CSRF token 全部失效
      const existingSecret = getEnvValue(backendTargetPath, 'CSRF_SECRET');
      if (existingSecret && !isPlaceholderSecret(existingSecret)) {
        logStep('SKIP', `CSRF_SECRET already exists in .env - keeping existing value`);
      } else {
        const csrfSecret = generateJWTSecret();
        updateEnvFile(backendTargetPath, 'CSRF_SECRET', csrfSecret);
        logSuccess(`Generated and set CSRF_SECRET for Backend`);
      }
    }

    // AI 密钥加密专用密钥（独立于 JWT_SECRET，避免 JWT 轮换导致已存储的 AI 密钥全部失效）
    // 注意：不作为必需项，旧部署缺失时后端自动回退到 JWT_SECRET 派生
    if (process.env.AI_KEY_SECRET) {
      logStep('INFO', 'Using AI_KEY_SECRET from environment variable');
      updateEnvFile(backendTargetPath, 'AI_KEY_SECRET', process.env.AI_KEY_SECRET);
    } else if (shouldGenerateSecrets) {
      // B2: 同 JWT_SECRET——AI_KEY_SECRET 轮换会使数据库已存 AI 密钥
      // AES-256-GCM 解密失败,必须保持稳定
      const existingSecret = getEnvValue(backendTargetPath, 'AI_KEY_SECRET');
      if (existingSecret && !isPlaceholderSecret(existingSecret)) {
        logStep('SKIP', `AI_KEY_SECRET already exists in .env - keeping existing value`);
      } else {
        const aiKeySecret = generateJWTSecret();
        updateEnvFile(backendTargetPath, 'AI_KEY_SECRET', aiKeySecret);
        logSuccess(`Generated and set AI_KEY_SECRET for Backend`);
      }
    }

    // R5 #1: TRUST_PROXY / CSRF_COOKIE_SECURE 从环境透传到生成的 .env——
    // Docker/反代部署时通过环境变量注入即可生效（.env.example 中有注释说明）
    if (process.env.TRUST_PROXY) {
      logStep('INFO', 'Using TRUST_PROXY from environment variable');
      updateEnvFile(backendTargetPath, 'TRUST_PROXY', process.env.TRUST_PROXY);
    }

    if (process.env.CSRF_COOKIE_SECURE) {
      logStep('INFO', 'Using CSRF_COOKIE_SECURE from environment variable');
      updateEnvFile(backendTargetPath, 'CSRF_COOKIE_SECURE', process.env.CSRF_COOKIE_SECURE);
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
    logSuccess('All environment files already exist');
  }

  logSuccess('Environment files module completed');
  return !envCreated;
}

async function initializeDatabase() {
  logSection('Module 2: Initialize Database');

  // The backend itself (connection.ts + init.ts) resolves DB_FILE, creates the
  // parent directory, and runs migrations on startup. This module only ensures
  // the target directory exists ahead of time so volume mounts and permissions
  // are handled gracefully before the server starts.
  const backendDir = path.join(__dirname, 'backend');
  const dbFile = process.env.DB_FILE
    ? path.resolve(process.env.DB_FILE)
    : path.join(backendDir, 'data', 'mindmap.db');
  const dataDir = path.dirname(dbFile);

  ensureDirectoryExists(dataDir);

  const dbExists = fs.existsSync(dbFile);

  if (dbExists) {
    logStep('SKIP', 'Database file already exists - skipping initialization');
  } else {
    logStep('INFO', 'Database file will be created by the backend server on startup');
  }

  if (isProduction() || isDockerEnvironment()) {
    logStep('INFO', 'Production/Docker mode - database will be initialized by backend server');
  } else {
    logStep('INFO', 'Development mode - database initialization will be handled by backend server');
  }

  return dbExists;
}

function getEnvValue(envPath, key) {
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, 'utf-8');
  const regex = new RegExp(`^${key}=(.*)$`, 'm');
  const match = content.match(regex);
  return match ? match[1].trim() : undefined;
}

async function waitForProcessReady(childProcess, healthUrl, name, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = options.intervalMs || 500;

  return new Promise((resolve, reject) => {
    let timeoutId;
    let intervalId;
    let resolved = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };

    const markResolved = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve();
      }
    };

    timeoutId = setTimeout(() => {
      if (!resolved) {
        logWarning(`${name} health check timed out after ${timeoutMs}ms, proceeding anyway`);
        markResolved();
      }
    }, timeoutMs);

    childProcess.once('error', (error) => {
      if (!resolved) {
        cleanup();
        reject(error);
      }
    });

    childProcess.once('exit', (code) => {
      if (!resolved && code !== null && code !== 0) {
        cleanup();
        reject(new Error(`${name} process exited with code ${code}`));
      }
    });

    const checkReady = async () => {
      const controller = new AbortController();
      const abortTimeoutId = setTimeout(() => controller.abort(), intervalMs);
      try {
        const response = await fetch(healthUrl, { signal: controller.signal });
        clearTimeout(abortTimeoutId);
        // 后端 /health 返回 200；前端 dev server 任意非 5xx 响应均视为已就绪
        if (response.ok || response.status < 500) {
          markResolved();
        }
      } catch {
        clearTimeout(abortTimeoutId);
        // Not ready yet, continue polling
      }
    };

    intervalId = setInterval(checkReady, intervalMs);
    // Initial check after a short delay to let the server start binding
    setTimeout(checkReady, 200);
  });
}

async function startBackend() {
  logSection('Starting Backend');

  const backendDir = path.join(__dirname, 'backend');

  try {
    let command, args;
    const isProdOrDocker = isProduction() || isDockerEnvironment();

    if (isProdOrDocker) {
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
        NODE_ENV: isProdOrDocker ? 'production' : 'development',
      },
    });

    backendProcess.on('error', (error) => {
      logError(`Backend process error: ${error.message}`);
      throw error;
    });

    const backendPort = process.env.PORT || getEnvValue(path.join(backendDir, '.env'), 'PORT') || (isProdOrDocker ? '9000' : '3000');
    await waitForProcessReady(backendProcess, `http://localhost:${backendPort}/health`, 'Backend');

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

      const frontendPort = process.env.FRONTEND_PORT || getEnvValue(path.join(frontendDir, '.env'), 'PORT') || '5173';
      await waitForProcessReady(frontendProcess, `http://localhost:${frontendPort}/`, 'Frontend');

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
   --install-only    Install dependencies only (npm install)
   --production      Run in production mode
   --help, -h        Show this help message
   (--generate-env-only 为 --env-only 的兼容别名)

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

  // B19: 兼容 package.json 旧脚本参数（--generate-env-only / --install-only）,
  // 避免历史 npm 脚本触发完整启动
  const envOnly = args.includes('--env-only') || args.includes('--generate-env-only');
  const dbOnly = args.includes('--db-only');
  const startOnly = args.includes('--start-only');
  const installOnly = args.includes('--install-only');
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
    if (installOnly) {
      logSection('Running Install Only');
      await executeCommand(getNpmCommand(), ['install'], { cwd: __dirname });
      logSuccess('Dependencies installed.');
      process.exit(0);
    }

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
