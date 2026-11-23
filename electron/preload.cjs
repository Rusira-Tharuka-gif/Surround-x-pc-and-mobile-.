const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('surroundDesktop', {
  platform: process.platform,
  isElectron: true,
});
