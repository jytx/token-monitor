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
    }
  ],
  // dev 多账号：面板为手写托管列表，只借共享保存路径（同 kimi/volcengine 的 custom 模式）。
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
