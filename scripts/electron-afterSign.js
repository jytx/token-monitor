'use strict';

// electron-builder afterSign hook（macOS）：
// 1. 用与主应用相同的 Developer ID 给 WidgetKit 扩展单独签名（含自身 entitlements）
// 2. 重新签名主应用，使其签名 seal 覆盖 Contents/PlugIns —— 公证会校验嵌套签名，
//    顺序必须是「先签扩展、再重签主应用」。
// 本地无证书（开发组装）时跳过并告警。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WIDGET_APPEX_RELATIVE = path.join('Contents', 'PlugIns', 'TokenMonitorWidget.appex');
const WIDGET_ENTITLEMENTS = path.join(__dirname, '..', 'widget', 'TokenMonitorWidget', 'TokenMonitorWidget.entitlements');
const APP_ENTITLEMENTS = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');

// 从当前 keychain 里找 Developer ID 证书（CI 中由 CSC_LINK 导入）。
// 返回证书名（如 "Developer ID Application: Xxx (TEAMID)"），找不到返回 null。
function findDeveloperIdentity() {
  let output;
  try {
    output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  } catch (error) {
    console.warn(`[afterSign] security find-identity 失败: ${error.message}`);
    return null;
  }
  const match = output.match(/"([^"]*Developer ID Application:[^"]*)"/);
  if (!match) {
    // 兼容 Apple Development 证书（本地调试场景）
    const devMatch = output.match(/"([^"]*Apple Development:[^"]*)"/);
    return devMatch ? devMatch[1] : null;
  }
  return match[1];
}

// context.appOutDir 在 --dir 模式下是父目录（dist/mac-arm64），
// 打包 .app 产物时则是 .app 本身；统一解析到 .app bundle 路径。
function appBundlePath(appOutDir) {
  if (String(appOutDir).endsWith('.app')) return appOutDir;
  const candidates = fs.readdirSync(appOutDir).filter((name) => name.endsWith('.app'));
  return candidates.length === 1 ? path.join(appOutDir, candidates[0]) : null;
}

module.exports = async function afterSign(context) {
  const appPath = appBundlePath(context.appOutDir);
  if (!appPath) {
    console.warn('[afterSign] 无法定位 .app bundle，跳过小组件扩展签名:', context.appOutDir);
    return;
  }
  const appexPath = path.join(appPath, WIDGET_APPEX_RELATIVE);
  if (!fs.existsSync(appexPath)) {
    console.log('[afterSign] 未找到小组件扩展，跳过签名');
    return;
  }
  const identity = findDeveloperIdentity();
  if (!identity) {
    console.warn('[afterSign] 未找到可用证书，跳过小组件扩展签名（本地开发组装请用 ad-hoc）');
    return;
  }

  // 1. 先签扩展：--options runtime（hardened runtime）+ 扩展自身的 App Group entitlements
  execFileSync('codesign', [
    '--force', '--sign', identity,
    '--timestamp', '--options', 'runtime',
    '--entitlements', WIDGET_ENTITLEMENTS,
    appexPath
  ], { stdio: 'inherit' });

  // 2. 再重签主应用：seal 覆盖 PlugIns；entitlements 与 electron-builder 配置一致
  execFileSync('codesign', [
    '--force', '--sign', identity,
    '--timestamp', '--options', 'runtime',
    '--entitlements', APP_ENTITLEMENTS,
    appPath
  ], { stdio: 'inherit' });

  console.log('[afterSign] 小组件扩展已签名:', appexPath);
};
