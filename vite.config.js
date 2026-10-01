import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import JavaScriptObfuscator from 'javascript-obfuscator';

function flovaObfuscatorPlugin() {
  return {
    name: 'vite-plugin-flova-obfuscator',
    apply: 'build',
    enforce: 'post',
    generateBundle(options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const file = bundle[fileName];
        if (file.type === 'chunk' && fileName.endsWith('.js')) {
          console.log(`[Flova Obfuscator] Obfuscating chunk: ${fileName}...`);
          const obfuscationResult = JavaScriptObfuscator.obfuscate(file.code, {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.7,
            deadCodeInjection: false,
            debugProtection: false,
            disableConsoleOutput: false,
            identifierNamesGenerator: 'hexadecimal',
            identifiersPrefix: '_0x',
            numbersToExpressions: true,
            renameGlobals: false,
            selfDefending: false,
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 8,
            stringArray: true,
            stringArrayCallsTransform: true,
            stringArrayEncoding: ['base64'],
            stringArrayIndexShift: true,
            stringArrayRotate: true,
            stringArrayShuffle: true,
            stringArrayThreshold: 0.85,
            transformObjectKeys: true,
            unicodeEscapeSequence: false
          });
          file.code = obfuscationResult.getObfuscatedCode();
          console.log(`[Flova Obfuscator] ${fileName} obfuscated successfully (${file.code.length} chars).`);
        }
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), flovaObfuscatorPlugin()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild'
  },
  server: {
    port: 3000,
    open: true
  }
});

