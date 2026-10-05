// pm2 process file: `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: "iliiad-bot",
      script: "dist/index.js",
      node_args: "--env-file-if-exists=.env",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 50,
    },
  ],
};
