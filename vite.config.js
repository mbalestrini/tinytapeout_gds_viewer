import { defineConfig } from 'vite';

export default defineConfig({
  base: '', // this allows deployment to a subdirectory (e.g. https://tinytapeout.github.io/tinytapeout_gds_viewer/)

  plugins: [
    {
      name: 'watch-gds-files',
      handleHotUpdate({ file, server }) {
        // this allows hot-reloading of .gds files
        if (file.endsWith('.gds')) {
          server.ws.send({
            type: 'custom',
            event: 'my-gds-change', // viewer.js listens for this event
            data: {},
          });
        }
      },
    },
  ],

  worker: {
    format: 'es',
  },
});
