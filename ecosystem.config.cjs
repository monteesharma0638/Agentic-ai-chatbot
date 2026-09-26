// PM2 process file: `npm run build && pm2 start ecosystem.config.cjs`
// Each service reads the .env file in its own folder.
module.exports = {
  apps: [
    {
      name: 'mf-mcp',
      cwd: './mcp-server',
      script: 'dist/index.js',
      args: '--http',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
    },
    {
      name: 'mf-agent',
      cwd: './agent-service',
      script: 'dist/index.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
    },
  ],
};
