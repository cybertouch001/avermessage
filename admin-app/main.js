// AverChat Admin — Windows desktop app. It opens the AverChat admin panel (same server as the app) in its own
// window with its own saved login. Optional: --server=https://other.example to point it at another AverChat server.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

const arg = process.argv.find((a) => a.startsWith('--server='));
const SERVER = (arg ? arg.slice(9) : process.env.AVERCHAT_SERVER || 'https://avermessage.sites.tab.bot').replace(/\/+$/, '');
const ORIGIN = new URL(SERVER).origin;
let win = null;

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(create);
  app.on('window-all-closed', () => app.quit());
}

function create() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, title: 'AverChat Admin', backgroundColor: '#0b0816',
    icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { partition: 'persist:averchat-admin', contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'AverChat Admin', submenu: [
      { label: 'Reload', accelerator: 'F5', click: () => win.reload() },
      { label: 'Open in browser', click: () => shell.openExternal(SERVER + '/admin') },
      { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'quit' } ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  win.once('ready-to-show', () => win.show());
  // stay on the AverChat server; anything else opens in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { server: SERVER, err: desc } }); });
  win.webContents.session.on('will-download', (e, item) => { item.setSaveDialogOptions && item.setSaveDialogOptions({ defaultPath: item.getFilename() }); });
  win.loadURL(SERVER + '/admin');
}
