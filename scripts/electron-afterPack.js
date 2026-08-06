'use strict';

// electron-builder afterPack hook：把构建好的 WidgetKit 小组件扩展拷入
// .app/Contents/PlugIns/，使其随主应用一起分发。
// 本地未先运行 scripts/build-widget.sh 时（widget/build 不存在）直接跳过，
// 保证纯 JS 开发流程不受影响。

const fs = require('node:fs');
const path = require('node:path');

const WIDGET_APPEX_SOURCE = path.join(__dirname, '..', 'widget', 'build', 'TokenMonitorWidget.appex');
const WIDGET_APPEX_NAME = 'TokenMonitorWidget.appex';

// context.appOutDir 在 --dir 模式下是父目录（dist/mac-arm64），
// 打包 .app 产物时则是 .app 本身；统一解析到 .app bundle 路径。
function appBundlePath(appOutDir) {
  if (String(appOutDir).endsWith('.app')) return appOutDir;
  const candidates = fs.readdirSync(appOutDir).filter((name) => name.endsWith('.app'));
  return candidates.length === 1 ? path.join(appOutDir, candidates[0]) : null;
}

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(WIDGET_APPEX_SOURCE)) {
    console.log('[afterPack] 未找到小组件扩展（widget/build 不存在），跳过安装');
    return;
  }
  const appPath = appBundlePath(context.appOutDir);
  if (!appPath) {
    console.warn('[afterPack] 无法定位 .app bundle，跳过小组件扩展安装:', context.appOutDir);
    return;
  }
  const plugInsDir = path.join(appPath, 'Contents', 'PlugIns');
  const target = path.join(plugInsDir, WIDGET_APPEX_NAME);
  fs.mkdirSync(plugInsDir, { recursive: true });
  fs.cpSync(WIDGET_APPEX_SOURCE, target, { recursive: true });
  console.log('[afterPack] 已安装小组件扩展:', target);
};
