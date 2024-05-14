import { defineConfig } from 'vite';

export default defineConfig({
  base: '', // this allows deployment to a subdirectory (e.g. https://tinytapeout.github.io/tinytapeout_gds_viewer/)

  plugins: [
    {
      name: 'watch-gltf-files',
      handleHotUpdate({ file, server }) {
        // this allows hot-reloading of .gltf files
        if (file.endsWith('.gltf')) {
          server.ws.send({
            type: 'custom',
            event: 'my-gltf-change', // viewer.js listens for this event
            data: {},
          });
        }
      },
    },
  ],
});
