import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.surroundx.studio',
  appName: 'Surround X',
  webDir: 'dist',
  backgroundColor: '#020C16',
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#020C16',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
