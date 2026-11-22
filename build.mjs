// 宿主端 → lib/index.js（Node ESM）；网页端 → lib/client.js（DSH 的动态 client 模块，React 由网页外壳提供）
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm('lib', { recursive: true, force: true });
// 插件本体和 AI 工具两个入口，共用的模块（runtime.ts）拆进 lib/chunks/，两边拿到的是同一份
await build({
  entryPoints: { index: 'src/index.ts', agent: 'src/agent.ts' },
  outdir: 'lib',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
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
