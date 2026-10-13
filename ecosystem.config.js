// PM2 process file. Build first (`npm run build`), then: pm2 start ecosystem.config.js
// Both processes read settings from .env in this directory.
module.exports = {
  apps: [
    {
      // Owns the Bluetooth adapter. Exits on BLE trouble so PM2 restarts it cleanly.
      name: 'plant-collector',
      script: 'dist/src/collector/index.js',
      cwd: __dirname,
      autorestart: true,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '200M',
      kill_timeout: 5000,
      time: true,
    },
    {
      // Dashboard, setup pages, API and alerts.
      name: 'plant-web',
      script: 'dist/src/web/index.js',
      cwd: __dirname,
      autorestart: true,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '200M',
      time: true,
    },
  ],
};
