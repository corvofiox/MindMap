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

/**
 * 检测是否在 Docker 环境中运行
 * 检查多个标志以确保可靠性
 */
function isDockerEnvironment() {
  // 检查环境变量（最可靠）
  if (process.env.DOCKER_CONTAINER === 'true') {
    return true;
  }

  // 检查 /.dockerenv 文件（Docker 创建的标志文件）
  if (fs.existsSync('/.dockerenv')) {
    return true;
  }

  // 检查 /proc/1/cgroup（在 Linux 上检查是否在容器中）
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    if (cgroup.includes('docker') || cgroup.includes('kubepods')) {
      return true;
    }
  } catch (e) {
    // Windows 或非 Linux 系统忽略此检查
  }

  return false;
}

/**
 * 检测是否在 Windows 平台
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * 检测是否在生产模式
 */
function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * 获取适合当前平台的 npm 命令
 * 注意：在 Windows 上必须使用 npm.cmd 扩展名，且需要通过 shell 执行
 */
function getNpmCommand() {
  return isWindows() ? 'npm.cmd' : 'npm';
}

/**
 * 获取适合当前平台的 Node 命令
 */
function getNodeCommand() {
  return 'node';
}

/**
 * 执行命令并继承 stdio（用于交互式命令）
 * 注意：在 Windows 上执行 .cmd 文件必须使用 shell
 */
async function executeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const cwd = options.cwd || __dirname;
    const env = { ...process.env, ...options.env };

    logStep('EXEC', `Running: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: isWindows(), // Windows 需要 shell 来执行 .cmd 文件
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

/**
 * 执行命令并捕获输出
 * 注意：在 Windows 上执行 .cmd 文件必须使用 shell
 */
async function executeCommandWithOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const cwd = options.cwd || __dirname;
    const env = { ...process.env, ...options.env };
    let output = '';
    let errorOutput = '';

    const child = spawn(command, args, {
      shell: isWindows(), // Windows 需要 shell 来执行 .cmd 文件
      cwd,
      env,
    });

    child.stdout?.on('data', (data) => {
      output += data.toString();
    });

    child.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${errorOutput || output}`));
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

function checkNodeModulesExists(dir) {
  return fs.existsSync(path.join(dir, 'node_modules'));
}

async function installDependencies(options = {}) {
  logSection('Installing Dependencies');

  const { force = false, clean = false } = options;
  const dirs = ['.', 'shared', 'backend', 'frontend'];

  for (const dir of dirs) {
    const dirPath = path.join(__dirname, dir);
    const nodeModulesPath = path.join(dirPath, 'node_modules');
    const packageLockPath = path.join(dirPath, 'package-lock.json');

    // 检查是否需要安装
    const nodeModulesExists = checkNodeModulesExists(dirPath);
    if (!force && nodeModulesExists) {
      logStep('SKIP', `Dependencies already installed in ${dir || 'root'}`);
      continue;
    }

    // 如果需要清理，先删除 node_modules 和 package-lock.json
    if (clean && (nodeModulesExists || fs.existsSync(packageLockPath))) {
      logStep('CLEAN', `Cleaning dependencies in ${dir || 'root'}...`);
      try {
        if (fs.existsSync(nodeModulesPath)) {
          fs.rmSync(nodeModulesPath, { recursive: true, force: true });
        }
        if (fs.existsSync(packageLockPath)) {
          fs.rmSync(packageLockPath);
        }
        logSuccess(`Cleaned dependencies in ${dir || 'root'}`);
      } catch (error) {
        logWarning(`Failed to clean dependencies in ${dir || 'root'}: ${error.message}`);
      }
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

/**
 * 检查关键依赖是否正确安装
 * @param {boolean} autoFix - 是否自动修复缺失的依赖
 * @returns {Promise<boolean>} - 返回 true 表示所有依赖都正常，false 表示存在问题
 */
async function checkDependenciesHealth(autoFix = false) {
  logSection('Checking Dependencies Health');

  const backendDir = path.join(__dirname, 'backend');
  const criticalModules = [
    'drizzle-orm',
    'drizzle-kit',
    'drizzle-orm/pg-core',
  ];

  let allHealthy = true;

  for (const moduleName of criticalModules) {
    try {
      // 尝试动态导入模块
      await import(moduleName);
      logStep('OK', `${moduleName} is available`);
    } catch (error) {
      allHealthy = false;
      logWarning(`${moduleName} is missing or not accessible`);

      if (autoFix) {
        logStep('FIX', `Attempting to fix ${moduleName}...`);
        try {
          // 尝试重新安装 backend 依赖
          await executeCommand(getNpmCommand(), ['install'], { cwd: backendDir });
          logSuccess(`Reinstalled dependencies for ${moduleName}`);

          // 再次检查
          try {
            await import(moduleName);
            logSuccess(`${moduleName} is now available`);
            allHealthy = true;
          } catch {
            logError(`Failed to fix ${moduleName}`);
          }
        } catch (fixError) {
          logError(`Failed to reinstall dependencies: ${fixError.message}`);
        }
      }
    }
  }

  if (allHealthy) {
    logSuccess('All critical dependencies are healthy');
  } else {
    logWarning('Some dependencies are missing');
  }

  return allHealthy;
}

/**
 * 初始化数据库
 * 在生产环境和开发环境都需要初始化数据库
 */
async function initializeDatabase() {
  logSection('Initializing Database');

  // 先检查依赖是否健康
  logStep('CHECK', 'Verifying dependencies before database initialization...');
  const depsHealthy = await checkDependenciesHealth(true);

  if (!depsHealthy) {
    logWarning('Dependencies are not healthy, attempting to fix...');
    const backendDir = path.join(__dirname, 'backend');
    try {
      await executeCommand(getNpmCommand(), ['install'], { cwd: backendDir });
      logSuccess('Dependencies reinstalled');

      // 再次检查
      const recheck = await checkDependenciesHealth(false);
      if (!recheck) {
        throw new Error('Failed to fix dependencies');
      }
    } catch (error) {
      logError(`Failed to fix dependencies: ${error.message}`);
      logStep('HINT', 'Please run "npm install" in the backend directory manually');
      throw error;
    }
  }

  const backendDir = path.join(__dirname, 'backend');
  const dataDir = path.join(backendDir, 'data');

  ensureDirectoryExists(dataDir);

  const dbFile = path.join(dataDir, 'mindmap.db');
  const dbExists = fs.existsSync(dbFile);

  if (dbExists) {
    logStep('CHECK', 'Database file already exists');

    // 在生产环境下，即使数据库存在也检查 schema 是否需要更新
    if (isProduction() || isDockerEnvironment()) {
      logStep('INFO', 'Checking database schema...');
      try {
        await executeCommand(getNpmCommand(), ['run', 'db:push'], { cwd: backendDir });
        logSuccess('Database schema verified');
      } catch (error) {
        logWarning(`Database schema check failed: ${error.message}`);
      }
    } else {
      logStep('SKIP', 'Database initialization skipped');
    }

    return;
  }

  logStep('INIT', 'Initializing database...');

  try {
    // 先生成迁移
    await executeCommand(getNpmCommand(), ['run', 'db:generate'], { cwd: backendDir });
    // 推送 schema 到数据库
    await executeCommand(getNpmCommand(), ['run', 'db:push'], { cwd: backendDir });
    logSuccess('Database initialized successfully');
  } catch (error) {
    logError(`Failed to initialize database: ${error.message}`);
    throw error;
  }
}

/**
 * 启动后端服务
 * 开发模式：使用 npm run dev（tsx watch）
 * 生产模式：直接运行编译后的 Node.js 代码
 */
async function startBackend() {
  logSection('Starting Backend');

  const backendDir = path.join(__dirname, 'backend');

  try {
    let command, args;

    if (isProduction() || isDockerEnvironment()) {
      logStep('START', 'Starting backend in production mode...');

      // 检查编译后的文件是否存在
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
      shell: isWindows(), // Windows 需要 shell 来执行 .cmd 文件
      env: {
        ...process.env,
        // 确保在生产模式下设置正确的环境变量
        NODE_ENV: isProduction() || isDockerEnvironment() ? 'production' : 'development',
      },
    });

    backendProcess.on('error', (error) => {
      logError(`Backend process error: ${error.message}`);
      throw error;
    });

    // 等待一小段时间确保进程启动成功
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // 5秒后认为进程启动成功（因为可能没有立即输出）
        resolve();
      }, 5000);

      backendProcess.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      // 如果进程立即退出，说明启动失败
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

/**
 * 启动前端服务
 * 开发模式：使用 Vite 开发服务器
 * 生产模式：不启动（由后端静态服务）
 */
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
        shell: isWindows(), // Windows 需要 shell 来执行 .cmd 文件
        env: process.env,
      });

      frontendProcess.on('error', (error) => {
        logError(`Frontend process error: ${error.message}`);
        throw error;
      });

      // 等待一小段时间确保进程启动成功
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

/**
 * 构建前端
 */
async function buildFrontend() {
  logSection('Building Frontend');

  const frontendDir = path.join(__dirname, 'frontend');

  try {
    logStep('CHECK', 'Checking frontend dependencies...');
    if (!checkNodeModulesExists(frontendDir)) {
      logWarning('Frontend dependencies not found. Installing...');
      await executeCommand(getNpmCommand(), ['install'], { cwd: frontendDir });
    }

    logStep('BUILD', 'Building frontend with TypeScript and Vite...');
    await executeCommand(getNpmCommand(), ['run', 'build'], { cwd: frontendDir });

    // 验证构建产物
    const distPath = path.join(frontendDir, 'dist');
    if (!fs.existsSync(distPath)) {
      throw new Error('Frontend dist directory not found after build');
    }

    logSuccess('Frontend built successfully');
  } catch (error) {
    logError(`Failed to build frontend: ${error.message}`);
    throw error;
  }
}

/**
 * 构建后端
 */
async function buildBackend() {
  logSection('Building Backend');

  const backendDir = path.join(__dirname, 'backend');

  try {
    logStep('CHECK', 'Checking backend dependencies...');
    if (!checkNodeModulesExists(backendDir)) {
      logWarning('Backend dependencies not found. Installing...');
      await executeCommand(getNpmCommand(), ['install'], { cwd: backendDir });
    }

    logStep('BUILD', 'Building backend with TypeScript...');
    await executeCommand(getNpmCommand(), ['run', 'build'], { cwd: backendDir });

    // 验证构建产物
    const distPath = path.join(backendDir, 'dist', 'index.js');
    if (!fs.existsSync(distPath)) {
      throw new Error('Backend dist/index.js not found after build');
    }

    logSuccess('Backend built successfully');
  } catch (error) {
    logError(`Failed to build backend: ${error.message}`);
    throw error;
  }
}

/**
 * 清理构建产物
 */
async function cleanBuild() {
  logSection('Cleaning Build Artifacts');

  const frontendDist = path.join(__dirname, 'frontend', 'dist');
  const backendDist = path.join(__dirname, 'backend', 'dist');

  let cleaned = false;

  // 清理前端构建产物
  if (fs.existsSync(frontendDist)) {
    try {
      fs.rmSync(frontendDist, { recursive: true, force: true });
      logSuccess('Cleaned frontend dist directory');
      cleaned = true;
    } catch (error) {
      logWarning(`Failed to clean frontend dist: ${error.message}`);
    }
  }

  // 清理后端构建产物
  if (fs.existsSync(backendDist)) {
    try {
      fs.rmSync(backendDist, { recursive: true, force: true });
      logSuccess('Cleaned backend dist directory');
      cleaned = true;
    } catch (error) {
      logWarning(`Failed to clean backend dist: ${error.message}`);
    }
  }

  // 清理 TypeScript 构建缓存
  const backendDir = path.join(__dirname, 'backend');
  const tsbuildinfoFiles = fs.readdirSync(backendDir)
    .filter(file => file.endsWith('.tsbuildinfo'))
    .map(file => path.join(backendDir, file));

  if (tsbuildinfoFiles.length > 0) {
    try {
      tsbuildinfoFiles.forEach(file => fs.rmSync(file));
      logSuccess('Cleaned TypeScript build cache');
      cleaned = true;
    } catch (error) {
      logWarning(`Failed to clean TypeScript build cache: ${error.message}`);
    }
  }

  if (!cleaned) {
    logStep('INFO', 'No build artifacts to clean');
  } else {
    logSuccess('Build artifacts cleaned successfully');
  }
}

/**
 * 生产环境设置流程
 * 安装依赖 → 设置环境 → 初始化数据库 → 构建 → 启动
 */
async function runProductionSetup() {
  logSection('Production Setup');

  await installDependencies();
  await setupEnvironmentFiles();
  await initializeDatabase();
  await buildFrontend();
  await buildBackend();

  logSuccess('Production setup completed');
}

/**
 * 开发环境设置流程
 * 安装依赖 → 设置环境 → 初始化数据库 → 启动
 */
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

/**
 * 获取适合当前平台的信号
 * Windows 不支持 SIGTERM，使用 SIGINT 代替
 */
function getShutdownSignal() {
  if (isWindows()) {
    return 'SIGINT';
  }
  return 'SIGTERM';
}

/**
 * 处理进程关闭
 * 确保所有子进程都被正确关闭
 */
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

          // 在 Windows 上使用不同的信号
          const killSignal = isWindows() ? 'SIGINT' : signal;

          // 发送关闭信号
          p.process.kill(killSignal);

          // 设置超时，强制杀死未响应的进程
          const timeout = setTimeout(() => {
            if (!p.process.killed) {
              logWarning(`Force killing ${p.name} (PID: ${p.process.pid})...`);
              p.process.kill('SIGKILL');
            }
            resolve();
          }, 5000);

          // 监听进程退出
          p.process.once('exit', () => {
            clearTimeout(timeout);
            logSuccess(`${p.name} stopped`);
            resolve();
          });
        } catch (error) {
          // 进程可能已经退出
          logWarning(`Error stopping ${p.name}: ${error.message}`);
          resolve();
        }
      });
    });

    // 等待所有进程关闭
    await Promise.all(shutdownPromises);

    logSuccess('All processes stopped');
    process.exit(0);
  };

  // Windows 和 Unix 系统的信号处理
  if (isWindows()) {
    // Windows 只支持 SIGINT（Ctrl+C）
    process.on('SIGINT', () => shutdown('SIGINT'));

    // 处理 Windows 的 exit 事件（例如窗口关闭）
    process.on('exit', () => {
      if (!isShuttingDown.value) {
        logWarning('Process exiting without proper shutdown');
      }
    });
  } else {
    // Unix 系统支持多个信号
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 处理 SIGHUP（终端关闭）
    process.on('SIGHUP', () => shutdown('SIGHUP'));
  }

  // 处理未捕获的异常
  process.on('uncaughtException', (error) => {
    logError(`Uncaught Exception: ${error.message}`);
    console.error(error);
    shutdown('SIGTERM');
  });

  // 处理未处理的 Promise 拒绝
  process.on('unhandledRejection', (reason, promise) => {
    logError(`Unhandled Rejection at: ${promise}`);
    console.error(reason);
    shutdown('SIGTERM');
  });
}

/**
 * 打印帮助信息
 */
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
║           MindMap Application - Startup Script            ║
╚════════════════════════════════════════════════════════════╝

 Usage:
   node start.js [options]

 Options:
   --install-only       Install dependencies only
   --env-only           Setup environment files only
   --db-only            Initialize database only
   --build-only         Build frontend and backend only (production)
   --start-only         Start servers only (skip setup)
   --full-start         Full setup and start (install + env + db + build + start)
   --reinstall          Force reinstall dependencies
   --clean-install      Clean and reinstall dependencies
   --clean-build        Clean build artifacts only
   --fix-deps           Fix dependency issues (reinstall and verify)
   --production         Run in production mode
   --help, -h           Show this help message

 Examples:
   node start.js                    Full setup and start (development)
   node start.js --production       Production setup and start
   node start.js --install-only     Install dependencies only
   node start.js --start-only       Start servers without setup
   node start.js --build-only       Build only (for production)
   node start.js --full-start       Complete setup and launch
   node start.js --reinstall        Force reinstall all dependencies
   node start.js --clean-install    Clean and reinstall dependencies
   node start.js --clean-build      Clean build artifacts
   node start.js --fix-deps         Fix dependency issues

 Notes:
   - Docker environment is automatically detected
   - Production mode builds both frontend and backend
   - Use --start-only to skip setup steps
   - Database is initialized automatically if not exists
   - --full-start includes all setup steps and starts servers
   - --fix-deps is useful when you encounter module not found errors

${environmentInfo}
`);
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);

  // 处理帮助命令
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // 解析参数
  const installOnly = args.includes('--install-only');
  const envOnly = args.includes('--env-only');
  const dbOnly = args.includes('--db-only');
  const buildOnly = args.includes('--build-only');
  const startOnly = args.includes('--start-only');
  const fullStart = args.includes('--full-start');
  const reinstall = args.includes('--reinstall');
  const cleanInstall = args.includes('--clean-install');
  const shouldCleanBuild = args.includes('--clean-build');
  const fixDeps = args.includes('--fix-deps');
  const productionMode = args.includes('--production') || isProduction();

  // 确定运行环境
  const isDocker = isDockerEnvironment();
  const environment = isDocker ? 'Docker' : (productionMode ? 'Production' : 'Development');

  // 打印启动信息
  console.log('\n' + '='.repeat(60));
  log('MindMap Application Starter', 'magenta');
  console.log('='.repeat(60));
  log(`Environment: ${environment}`, 'cyan');
  log(`Platform: ${process.platform}`, 'cyan');
  log(`Node Version: ${process.version}`, 'cyan');
  log(`Working Directory: ${process.cwd()}`, 'cyan');
  console.log('='.repeat(60) + '\n');

  try {
    // 处理清理构建产物
    if (shouldCleanBuild) {
      await cleanBuild();
      logSuccess('Build artifacts cleaned. Run with --build-only to rebuild.');
      process.exit(0);
    }

    // 处理重新安装依赖
    if (reinstall) {
      await installDependencies({ force: true });
      logSuccess('Dependencies reinstalled. Run with --start-only to start servers.');
      process.exit(0);
    }

    // 处理清理后重新安装依赖
    if (cleanInstall) {
      await installDependencies({ clean: true });
      logSuccess('Dependencies reinstalled cleanly. Run with --start-only to start servers.');
      process.exit(0);
    }

    // 处理修复依赖
    if (fixDeps) {
      logSection('Fixing Dependencies');

      // 先安装所有依赖
      await installDependencies({ force: true });

      // 再检查并修复关键依赖
      const backendDir = path.join(__dirname, 'backend');
      logStep('FIX', 'Checking and fixing backend dependencies...');
      await executeCommand(getNpmCommand(), ['install'], { cwd: backendDir });

      const healthy = await checkDependenciesHealth(false);
      if (healthy) {
        logSuccess('All dependencies are now healthy');
      } else {
        logWarning('Some dependencies may still have issues');
        logStep('HINT', 'Try running "npm install" in the backend directory manually');
      }

      process.exit(0);
    }

    // 执行单独的操作
    if (installOnly) {
      await installDependencies();
      logSuccess('Dependencies installed. Run with --start-only to start servers.');
      process.exit(0);
    }

    if (envOnly) {
      await setupEnvironmentFiles();
      logSuccess('Environment files configured. Run with --start-only to start servers.');
      process.exit(0);
    }

    if (dbOnly) {
      await initializeDatabase();
      logSuccess('Database initialized. Run with --start-only to start servers.');
      process.exit(0);
    }

    if (buildOnly) {
      await runProductionSetup();
      logSuccess('Build completed. Run with --start-only to start servers.');
      process.exit(0);
    }

    // 一键启动：完整流程
    if (fullStart) {
      logSection('Full Start - Complete Setup and Launch');

      // 安装依赖（强制重新安装以确保最新）
      await installDependencies({ force: true });

      // 设置环境变量
      await setupEnvironmentFiles();

      // 初始化数据库
      await initializeDatabase();

      // 清理并重新构建
      await cleanBuild();
      await buildFrontend();
      await buildBackend();

      // 启动服务
      const processes = await startServers();
      handleShutdown(processes);
      return;
    }

    // 仅启动服务（跳过设置）
    if (startOnly || fullStart) {
      // 在生产模式下，需要确保数据库已初始化
      if (isDocker || productionMode) {
        logStep('CHECK', 'Ensuring database is initialized...');
        await initializeDatabase();
      }

      const processes = await startServers();
      handleShutdown(processes);
      return;
    }

    // 完整的启动流程
    if (isDocker || productionMode) {
      // Docker 或生产环境：完整设置 + 启动
      await runProductionSetup();
      const processes = await startServers();
      handleShutdown(processes);
    } else {
      // 开发环境：基础设置 + 启动
      await runDevelopmentSetup();
      const processes = await startServers();
      handleShutdown(processes);
    }

  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    console.error(error);

    // 打印堆栈跟踪以便调试
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }

    process.exit(1);
  }
}

// 启动主函数
main();
