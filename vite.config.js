import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'

const mapLibreWorker = resolve('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs')

export default defineConfig({
  base: '/opensource-batasadministrasi/',
  plugins: [{
    name: 'copy-maplibre-worker',
    async writeBundle(outputOptions) {
      const outputDir = outputOptions.dir || 'dist'
      const workerOutput = resolve(outputDir, 'assets/maplibre-gl-worker.mjs')
      await mkdir(dirname(workerOutput), { recursive: true })
      await copyFile(mapLibreWorker, workerOutput)
    },
  }],
})
