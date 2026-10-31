import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.onmydisk.app',
  appName: 'On My Disk',
  webDir: '../svar/dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https'
  },
  plugins: {
    CapacitorUpdater: {
      // IMPORTANT: We use manual update mode via our own version server.
      // autoUpdate MUST be false - if true, the plugin silently contacts
      // the Capgo cloud API (plugin.capgo.app) on every foreground event.
      autoUpdate: false,
      // Prevent native plugin from auto-deleting bundles that failed to load.
      // We handle retry logic ourselves in checkVersion() recovery.
      autoDeleteFailed: false,
      // Allow enough time for the WebView to load and call notifyAppReady()
      appReadyTimeout: 45000,
      // Increase response/download timeout from default 20s to 300s (5 minutes)
      // for downloading large web bundles on slow/mobile connections
      responseTimeout: 300,
    }
  }
};

export default config;
