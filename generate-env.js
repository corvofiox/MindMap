#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// 敏感配置生成函数
const generateSensitiveConfig = () => {
  return {
    JWT_SECRET: crypto.randomBytes(32).toString('base64'),
    // 可扩展其他敏感信息
    // DB_PASSWORD: crypto.randomBytes(16).toString('hex'),
  };
};

// 主函数
const generateEnvFile = () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  
  const envExamplePath = path.join(__dirname, 'backend', '.env.example');
  const envPath = path.join(__dirname, 'backend', '.env');
  
  // 检查.env文件是否已存在
  if (fs.existsSync(envPath)) {
    console.log('.env file already exists, skipping generation.');
    return;
  }
  
  // 读取.env.example内容
  const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');
  
  // 解析.env.example为对象
  const exampleConfig = envExampleContent
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .reduce((config, line) => {
      const [key, value] = line.split('=').map(item => item.trim());
      config[key] = value;
      return config;
    }, {});
  
  // 生成敏感配置
  const sensitiveConfig = generateSensitiveConfig();
  
  // 合并配置（敏感配置优先级更高）
  const finalConfig = {
    ...exampleConfig,
    ...sensitiveConfig,
    // 添加环境特定配置
    NODE_ENV: process.env.NODE_ENV || 'development'
  };
  
  // 生成.env文件内容
  const envContent = Object.entries(finalConfig)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  
  // 写入.env文件
  fs.writeFileSync(envPath, envContent, 'utf8');
  
  console.log('.env file generated successfully with secure sensitive information!');
  console.log('Generated sensitive keys:', Object.keys(sensitiveConfig).join(', '));
};

// 执行生成
generateEnvFile();