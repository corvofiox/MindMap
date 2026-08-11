// scripts/secret-persistence.js
//
// 密钥持久化模块:JWT_SECRET / CSRF_SECRET / AI_KEY_SECRET 的统一解析逻辑。
//
// 背景(B2 根治方案):Docker 容器内 backend/.env 不在持久卷上,start.js 每次
// 启动若重新生成随机密钥,容器重建会导致 ① 已登录用户 JWT 会话全部失效
// ② CSRF token 失效 ③ 数据库已存 AI 服务商密钥(AES-256-GCM,加密密钥=
// AI_KEY_SECRET)解密失败,用户必须重新输入所有 AI 密钥。
//
// 根治方案:密钥持久化到 backend/data/.secrets(与 mindmap.db 同目录,Docker
// 部署中该目录是持久卷挂载点 /app/backend/data),容器重建后从该文件恢复,
// 密钥不再轮换。文件格式为 key=value 行,仅含三个密钥,权限 0600。
//
// 单密钥取值优先级:
//   ① process.env 注入(compose/环境显式注入,最高优先;仅更新 .env,不写入
//      .secrets——与旧行为一致,部署注入优先但不污染持久化文件)
//   ② .secrets 持久化文件中的值(非占位符;写回 .env 保持 .env 完整)
//   ③ backend/.env 现有非占位符值(写回 .env 并迁移到 .secrets)
//   ④ 生成随机(canGenerate=true 时,同时写入 .env 与 .secrets)
//
// 本模块只依赖 node 内置模块,无副作用,便于 vitest 单元测试(路径与 env 可注入)。

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// 需要持久化的密钥集合(.secrets 文件仅包含这三个键)
export const SECRET_KEYS = ['JWT_SECRET', 'CSRF_SECRET', 'AI_KEY_SECRET'];

// 持久化文件名(位于 backend/data/ 下,与 mindmap.db 同目录)
export const SECRETS_FILE_NAME = '.secrets';

export function generateJWTSecret() {
  return crypto.randomBytes(64).toString('hex');
}

// .env.example / .env.development 模板中的示例占位符不算真实密钥——检测到占位符
// 时仍应生成随机密钥覆盖,否则全新部署会带着公开的弱密钥运行。
export function isPlaceholderSecret(value) {
  if (!value) return true;
  const v = value.trim();
  // R2-6: 识别 dev 环境模板密钥(backend/.env.development 的
  // dev-jwt-secret-key-for-development-only / dev-csrf-secret-key-for-development-only)
  return v === '' || v.includes('change-me-in-production') || v === 'your-secret-key'
    || (v.startsWith('dev-') && v.includes('key-for-development'));
}

export function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 更新 .env 中单个键的值(键不存在则追加),保持文件其余内容不变
export function updateEnvFile(envPath, key, value) {
  // 确保父目录存在(.env 首次创建时 backend/ 目录可能尚不存在)
  ensureDirectoryExists(path.dirname(envPath));
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

// 读取 .env 中单个键的值(文件不存在/键不存在返回 undefined)
export function getEnvValue(envPath, key) {
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, 'utf-8');
  const regex = new RegExp(`^${key}=(.*)$`, 'm');
  const match = content.match(regex);
  return match ? match[1].trim() : undefined;
}

// 计算 .secrets 持久化文件路径: <backendDir>/data/.secrets
export function getSecretsFilePath(backendDir) {
  return path.join(backendDir, 'data', SECRETS_FILE_NAME);
}

// 读取 .secrets 文件:返回 { KEY: value } 映射,仅保留 SECRET_KEYS 中的键,
// 忽略未知行(值是否占位符由 resolveSecret 用 isPlaceholderSecret 判定)。
export function readSecretsFile(secretsPath) {
  const result = {};
  if (!fs.existsSync(secretsPath)) return result;
  const content = fs.readFileSync(secretsPath, 'utf-8');
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && SECRET_KEYS.includes(match[1])) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

// 写入单个密钥到 .secrets:保留文件中其他已知密钥,文件仅含 SECRET_KEYS 三键,
// 权限固定 0600。父目录不存在时自动创建。
export function writeSecretsValue(secretsPath, key, value) {
  const current = readSecretsFile(secretsPath);
  current[key] = value;
  ensureDirectoryExists(path.dirname(secretsPath));
  const lines = SECRET_KEYS
    .filter(k => current[k] !== undefined)
    .map(k => `${k}=${current[k]}`);
  // m3: 原子写——先写同目录临时文件(创建即 0600),再 rename 覆盖,
  // 避免 writeFileSync 中途被杀/断电导致 .secrets 截断、部分密钥轮换。
  const tmpPath = `${secretsPath}.tmp`;
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, secretsPath);
  fs.chmodSync(secretsPath, 0o600);
}

// 解析单个密钥(优先级见文件头注释)。
// options:
//   envPath     - backend/.env 路径
//   secretsPath - backend/data/.secrets 路径
//   env         - 环境变量来源(默认 process.env,测试可注入)
//   canGenerate - 是否允许生成随机密钥。生产非 Docker 且 .env 有效时为 false,
//                 保持与旧行为一致:不凭空生成新密钥(缺失 AI_KEY_SECRET 时
//                 后端回退 JWT_SECRET 派生,生成反而会破坏已存 AI 密钥解密)。
//   generate    - 随机密钥生成函数(测试可注入)
// 返回 { value, source, conflictWithEnvFile? },source ∈ 'env' | 'secrets' | 'envfile' | 'generated' | 'none';
// source='secrets' 且 .env 存在不同非占位符值时,conflictWithEnvFile=true(.secrets 为权威,压过 .env)
export function resolveSecret(key, { envPath, secretsPath, env = process.env, canGenerate = true, generate = generateJWTSecret }) {
  // ① process.env 显式注入(最高优先;仅更新 .env,不写入 .secrets)
  if (env[key]) {
    updateEnvFile(envPath, key, env[key]);
    return { value: env[key], source: 'env' };
  }

  // ② .secrets 持久化文件(容器重建后恢复密钥的主路径)
  const fromSecrets = readSecretsFile(secretsPath)[key];
  if (fromSecrets && !isPlaceholderSecret(fromSecrets)) {
    // M1: 若 .env 中同键是不同非占位符值(用户手动轮换),.secrets 会压过它——
    // 返回 conflictWithEnvFile 标志,由调用方(如 start.js)打印 WARN 提示
    // "轮换密钥需更新 .secrets 或注入环境变量",避免运维以为轮换成功实际被回滚。
    const envVal = getEnvValue(envPath, key);
    const conflictWithEnvFile = Boolean(envVal && !isPlaceholderSecret(envVal) && envVal !== fromSecrets);
    updateEnvFile(envPath, key, fromSecrets);
    return { value: fromSecrets, source: 'secrets', conflictWithEnvFile };
  }

  // ③ backend/.env 已有非占位符值 → 保留并迁移到 .secrets(首次运行持久化)
  const fromEnv = getEnvValue(envPath, key);
  if (fromEnv && !isPlaceholderSecret(fromEnv)) {
    updateEnvFile(envPath, key, fromEnv);
    writeSecretsValue(secretsPath, key, fromEnv);
    return { value: fromEnv, source: 'envfile' };
  }

  // ④ 生成随机密钥,同时写入 .env 与 .secrets
  if (canGenerate) {
    const value = generate();
    updateEnvFile(envPath, key, value);
    writeSecretsValue(secretsPath, key, value);
    return { value, source: 'generated' };
  }

  return { value: undefined, source: 'none' };
}

// 批量解析三个密钥(JWT_SECRET / CSRF_SECRET / AI_KEY_SECRET)
export function resolveSecrets(options) {
  return SECRET_KEYS.map(key => ({
    key,
    ...resolveSecret(key, options),
  }));
}
