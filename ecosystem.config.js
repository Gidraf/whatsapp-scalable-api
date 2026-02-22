module.exports = {
  apps: [
    {
      name: 'wa-api',
      script: 'src/server.js',
      instances: 1, // Scales to available CPU cores
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};