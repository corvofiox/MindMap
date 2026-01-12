#!/usr/bin/env node

import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// 日志函数
const log = (message, color = 'reset') => {
  console.log(`${colors[color]}${message}${colors.reset}`);
};

const errorLog = (message) => {
  console.error(`${colors.red}ERROR: ${message}${colors.reset}`);
};

const successLog = (message) => {
  console.log(`${colors.green}✓ ${message}${colors.reset}`);
};

// 执行命令函数
const exec = (command, options = {}) => {
  log(`Executing: ${command}`, 'cyan');
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    ...options
  });
  return result;
};

// 执行异步命令
const execAsync = (command, options = {}) => {
  log(`Starting: ${command}`, 'cyan');
  return spawn(command, {
    shell: true,
    stdio: 'inherit',
    ...options
  });
};

// 检查Node.js和npm环境
const checkEnvironment = () => {
  log('\n🔍 Checking environment...', 'magenta');
  
  // 检查Node.js
  let nodeVersion = 'unknown';
  try {
    const nodeResult = spawnSync('node', ['--version'], { shell: true });
    if (nodeResult.status === 0) {
      nodeVersion = nodeResult.stdout.toString().trim();
      log(`Node.js version: ${nodeVersion}`, 'blue');
    } else {
      errorLog('Node.js is not installed. Please install Node.js (v20.0.0 or higher) first.');
      process.exit(1);
    }
  } catch (error) {
    errorLog('Failed to check Node.js version. Please ensure Node.js is installed.');
    process.exit(1);
  }
  
  // 检查npm
  let npmVersion = 'unknown';
  try {
    // 对于Windows环境，使用cmd.exe执行npm命令
    const npmResult = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', 
      process.platform === 'win32' ? ['/c', 'npm --version'] : ['--version'], 
      { shell: true });
    
    if (npmResult.status === 0) {
      npmVersion = npmResult.stdout.toString().trim();
      log(`npm version: ${npmVersion}`, 'blue');
    } else {
      // 尝试另一种方式检查npm
      try {
        const npmResult2 = spawnSync('npm', ['--version'], { shell: true });
        if (npmResult2.status === 0) {
          npmVersion = npmResult2.stdout.toString().trim();
          log(`npm version: ${npmVersion}`, 'blue');
        } else {
          throw new Error('npm check failed');
        }
      } catch (e) {
        errorLog('npm is not installed. Please install Node.js with npm.');
        process.exit(1);
      }
    }
  } catch (error) {
    errorLog('Failed to check npm version. Please ensure npm is installed.');
    process.exit(1);
  }
  
  successLog('Environment check passed!');
};

// 安装依赖
const installDependencies = () => {
  log('\n📦 Installing dependencies...', 'magenta');
  
  // 安装根目录依赖
  log('Installing root dependencies...', 'yellow');
  const rootResult = exec('npm install');
  if (rootResult.status !== 0) {
    errorLog('Failed to install root dependencies.');
    process.exit(1);
  }
  
  // 安装工作区依赖
  log('Installing workspace dependencies...', 'yellow');
  const workspaceResult = exec('npm install --workspaces');
  if (workspaceResult.status !== 0) {
    errorLog('Failed to install workspace dependencies.');
    process.exit(1);
  }
  
  successLog('Dependencies installed successfully!');
};

// 生成.env文件
const generateEnvFiles = () => {
  log('\n🔑 Generating environment files...', 'magenta');
  
  // 生成后端.env文件
  const generateEnvResult = exec('node generate-env.js');
  if (generateEnvResult.status !== 0) {
    errorLog('Failed to generate .env file.');
    process.exit(1);
  }
  
  // 检查前端.env文件
  const frontendEnvPath = path.join(__dirname, 'frontend', '.env');
  if (!fs.existsSync(frontendEnvPath)) {
    log('Creating frontend .env file from example...', 'yellow');
    const frontendEnvExamplePath = path.join(__dirname, 'frontend', '.env.example');
    if (fs.existsSync(frontendEnvExamplePath)) {
      fs.copyFileSync(frontendEnvExamplePath, frontendEnvPath);
      successLog('Frontend .env file created!');
    } else {
      log('No frontend .env.example found, skipping...', 'yellow');
    }
  } else {
    log('Frontend .env file already exists, skipping...', 'yellow');
  }
  
  successLog('Environment files generated successfully!');
};

// 初始化数据库
const initDatabase = () => {
  log('\n🗄️  Initializing database...', 'magenta');
  
  // 进入后端目录并执行数据库初始化
  const dbInitResult = exec('npm run db:init', { cwd: path.join(__dirname, 'backend') });
  if (dbInitResult.status !== 0) {
    log('Database initialization failed. This might be expected if the database already exists.', 'yellow');
  } else {
    successLog('Database initialized successfully!');
  }
};

// 构建项目
const buildProject = () => {
  log('\n🏗️  Building project...', 'magenta');
  
  const buildResult = exec('npm run build');
  if (buildResult.status !== 0) {
    errorLog('Failed to build project.');
    process.exit(1);
  }
  
  successLog('Project built successfully!');
};

// 启动开发服务器
const startDevServers = () => {
  log('\n🚀 Starting development servers...', 'magenta');
  log('Frontend will be available at http://localhost:5173', 'blue');
  log('Backend API will be available at http://localhost:3000', 'blue');
  log('WebSocket service will be available at ws://localhost:3001', 'blue');
  log('Press Ctrl+C to stop servers', 'yellow');
  
  exec('npm run dev');
};

// 启动生产服务器
const startProdServer = () => {
  log('\n🚀 Starting production server...', 'magenta');
  log('Application will be available at http://localhost:3000', 'blue');
  log('WebSocket service will be available at ws://localhost:3001', 'blue');
  log('Press Ctrl+C to stop server', 'yellow');
  
  // 直接执行 node backend/dist/index.js 命令，从根目录运行，确保能找到依赖
  exec('node backend/dist/index.js');
};

// 主函数
const main = () => {
  log('\n✨ MindMap One-Click Startup Script', 'magenta');
  log('===================================', 'magenta');
  
  // 解析命令行参数
  const args = process.argv.slice(2);
  const isDocker = args.includes('--docker'); // 检测是否在Docker环境中运行
  const mode = args.includes('--mode=production') ? 'production' : 'development';
  const initOnly = args.includes('--init-only');
  
  try {
    // 1. 检查环境
    checkEnvironment();
    
    // 2. 安装依赖（Docker环境跳过）
    if (!isDocker) {
      installDependencies();
    } else {
      log('Docker environment detected, skipping dependency installation...', 'yellow');
    }
    
    // 3. 生成环境文件
    generateEnvFiles();
    
    // 4. 初始化数据库
    initDatabase();
    
    // 5. 构建项目（Docker环境跳过）
    if (mode === 'production' && !isDocker) {
      buildProject();
    } else if (isDocker) {
      log('Docker environment detected, skipping project build...', 'yellow');
    }
    
    if (!initOnly) {
      // 6. 启动服务器
      if (isDocker) {
        // Docker环境：直接启动后端应用
        log('\n🚀 Starting MindMap application in Docker...', 'yellow');
        log('Application will be available at http://localhost:3000', 'blue');
        log('WebSocket service will be available at ws://localhost:3001', 'blue');
        log('Press Ctrl+C to stop server', 'yellow');
        // 直接执行 node backend/dist/index.js 命令，从根目录运行，确保能找到依赖
        exec('node backend/dist/index.js');
      } else if (mode === 'production') {
        startProdServer();
      } else {
        startDevServers();
      }
    } else {
      log('\n✅ Initialization completed successfully!', 'green');
      log('To start the development servers, run: npm run dev', 'yellow');
      log('To start the production server, run: npm run start', 'yellow');
    }
    
    successLog('\n🎉 One-click startup completed successfully!');
  } catch (error) {
    errorLog(`Unexpected error: ${error.message}`);
    process.exit(1);
  }
};

// 执行主函数
main();