const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('surroundDesktop', {
  platform: process.platform,
  isElectron: true,
  notifyConversionState: (state) => {
    ipcRenderer.send('surround:conversion-state', state);
  },
  showWindow: () => ipcRenderer.invoke('surround:show-window'),
});
