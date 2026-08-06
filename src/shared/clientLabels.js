'use strict';

// 工具客户端 → 展示名的唯一映射源。
// renderer（app.js 经 window.TokenMonitorClientLabels 读取）与
// src/shared/widgetSnapshot.js（Node 侧 require）共用同一份，避免两处维护漂移。
// 新增跟踪客户端时，除 AGENTS.md「Adding a tracked client」清单外，
// 本映射与 renderer 的 clientsWithIcon / trayProviderIcons 等需同步更新。

(function exposeClientLabels(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientLabels = api;
})(typeof window !== 'undefined' ? window : null, function createClientLabelsApi() {
  const clientLabels = {
    claude: 'Claude Code',
    codex: 'Codex',
    hermes: 'Hermes Agent',
    gemini: 'Gemini',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    openclaw: 'OpenClaw',
    antigravity: 'Antigravity',
    cline: 'Cline',
    kimi: 'Kimi',
    qwen: 'Qwen',
    grok: 'Grok Build',
    copilot: 'GitHub Copilot',
    pi: 'Pi',
    zed: 'Zed',
    kilocode: 'Kilo Code',
    micode: 'MiMo Code',
    zcode: 'ZCode',
    kiro: 'Kiro',
    codebuddy: 'CodeBuddy',
    workbuddy: 'WorkBuddy',
    proma: 'Proma'
  };

  function displayNameFor(id) {
    return clientLabels[id] || id;
  }

  return {
    clientLabels,
    displayNameFor
  };
});
