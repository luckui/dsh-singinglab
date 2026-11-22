// 宿主端 → lib/index.js（Node ESM）；网页端 → lib/client.js（DSH 的动态 client 模块，React 由网页外壳提供）
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm('lib', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
});
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  minify: true,
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-singinglab",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('built lib/index.js and lib/client.js');
