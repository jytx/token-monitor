'use strict';

// DeepSeek limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'deepseek',
  fetch: 'fetchDeepSeekLimits',
  fields: [
    {
      key: 'deepseekManagedAccounts',
      kind: 'managed',
      contextOverride: true,
      persist: 'never',
      initial: []
    },
    {
      key: 'deepseekApiKey',
      kind: 'credential',
      storePath: ['providers', 'deepseek', 'apiKey'],
      resolve: 'deepseekToken',
      resolveStyle: 'explicit'
    },
    {
      key: 'deepseekWebToken',
      kind: 'credential',
      storePath: ['providers', 'deepseek', 'webToken'],
      normalize: { fn: 'normalizeDeepseekWebToken', style: 'value' }
    }
  ],
  // dev 多账号：面板为手写托管列表，只借共享保存路径（同 kimi/volcengine 的 custom 模式）。
  // webToken 为上游新增的 provider 级 console 会话凭据（可选 Search/Fetch
  // 花费来源），settings 层可用；dev 手写面板暂未提供输入入口。
  form: {
    kind: 'custom',
    fields: [{ key: 'deepseekApiKey' }]
  },
  status: {
    credential: 'deepseekApiKey',
    configuredKey: 'deepseekApiKeyConfigured',
    sourceKey: 'deepseekApiKeySource',
    pendingKey: 'deepseekPendingCheckSince'
  },
  urlPolicy: [
    { hosts: ['platform.deepseek.com'], pathPrefixes: ['/api_keys'] }
  ]
};
