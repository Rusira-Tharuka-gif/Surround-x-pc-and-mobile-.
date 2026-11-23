import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.surroundx.studio',
  appName: 'Surround X',
  webDir: 'dist',
  backgroundColor: '#07090E',
  android: {
    allowMixedContent: true,
  },
};

export default config;
