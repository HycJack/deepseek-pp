import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));
const safeWxtBrowser = resolve(rootDir, 'core/browser/safe-wxt-browser.ts');

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DeepSeek++',
    description: 'Agentic memory & skill system for DeepSeek',
    version: '0.1.0',
    permissions: ['sidePanel', 'storage', 'alarms', 'nativeMessaging'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    host_permissions: ['*://chat.deepseek.com/*'],
  },
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@wxt-dev/browser': safeWxtBrowser,
        'wxt/browser': safeWxtBrowser,
      },
    },
  }),
});
