/**
 * 会动的插画（WebGL）：像 Wallpaper Engine 的做法，不重画动画，而是按一张特效遮罩逐像素加动效。
 * 遮罩的四个通道（assets 里的 mask-*.png，和插画同比例）：
 *   R 随风摆   窗帘、藤叶、发梢：按位置错开相位的轻微横向摆动
 *   G 水面     两组波叠加去折射底图，越近波越大；太阳照到的亮处闪烁高光，声音大、打拍子时闪得更多
 *   B 窗玻璃   夜里的雨：玻璃上的水珠（折射窗外）、往下滑的雨滴和水痕，水珠以外是起雾的玻璃（模糊图）
 *   A 热气     茶杯上方往上飘的扭动
 * WebGL 不能用时退回一张静态图。
 */

import React, { useEffect, useRef, useState } from 'react';
import { getEngine } from './engine';
import { upper } from './scene';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform sampler2D uImg;
uniform sampler2D uMask;
uniform sampler2D uBlur;
uniform float uT;
uniform float uEnergy;
uniform float uBeat;
uniform float uRain;
uniform float uHorizon;
uniform vec2 uRes;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }

// 玻璃上的雨：返回折射偏移（xy）和「这里是水」的程度（z）
vec3 rain(vec2 uv, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 off = vec2(0.0);
  float wet = 0.0;
  // 静止的小水珠
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 38.0 : 22.0;
    vec2 g = p * scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 h = hash2(id + float(layer) * 17.0);
    vec2 c = (h - 0.5) * 0.7;
    float r = (0.1 + 0.18 * hash(id + 3.1)) * (layer == 0 ? 0.8 : 1.0);
    float life = step(0.35, hash(id + floor(t * 0.05 + h.x)));   // 有的格子没有水珠，隔一阵换一批
    vec2 d = f - c;
    float inside = smoothstep(r, r * 0.6, length(d)) * life;
    off += d * inside * 0.9 / scale;
    wet = max(wet, inside);
  }
  // 往下滑的雨滴：一列一列，各自速度不同，后面拖一条水痕
  float cols = 26.0;
  float cx = floor(p.x * cols);
  float colSeed = hash(vec2(cx, 7.3));
  float speed = 0.06 + 0.14 * colSeed;
  float y = fract(uv.y * 1.0 - t * speed - colSeed * 10.0);
  float x = fract(p.x * cols) - 0.5 - (sin(uv.y * 30.0 + colSeed * 50.0) * 0.12);
  float head = smoothstep(0.045, 0.0, length(vec2(x * 0.9, (y - 0.06) * 3.2)));
  float trail = smoothstep(0.06, 0.0, abs(x)) * smoothstep(0.06, 0.4, y) * smoothstep(1.0, 0.3, y) * 0.55;
  float active = step(0.45, hash(vec2(cx, floor(t * speed + colSeed * 10.0))));
  head *= active; trail *= active;
  off += vec2(x * 0.02, -0.01) * head;
  wet = max(wet, max(head, trail * 0.6));
  return vec3(off, wet);
}

void main() {
  vec2 uv = vUv;
  vec4 m = texture2D(uMask, uv);
  vec2 off = vec2(0.0);
  vec3 add = vec3(0.0);

  if (m.r > 0.002) {
    float ph = uT * 0.85 + uv.y * 6.0 + uv.x * 3.0;
    off.x += m.r * (sin(ph) * 0.0024 + sin(ph * 2.3 + 1.7) * 0.0009);
    off.y += m.r * sin(ph * 0.7 + 0.5) * 0.0007;
  }

  if (m.g > 0.002) {
    float depth = clamp((uv.y - uHorizon) / 0.3, 0.0, 1.0);
    float k = mix(420.0, 90.0, depth);
    float w1 = sin(uv.x * k * 0.55 + uT * 1.5 + sin(uv.y * k * 1.1 + uT * 0.6) * 1.4);
    float w2 = sin(uv.x * k * 1.35 - uT * 2.2 + uv.y * k * 0.5);
    float h = w1 * 0.6 + w2 * 0.4;
    off += vec2(0.0011 * h, 0.0009 * w2) * m.g;
    vec3 base = texture2D(uImg, uv + off).rgb;
    float bright = dot(base, vec3(0.299, 0.587, 0.114));
    // 闪光：稀疏的圆点，只在画里本来就亮的水面（太阳、月亮照到的地方），一闪一闪
    vec2 gp = uv * uRes / vec2(7.0, 4.0);
    vec2 cell = floor(gp);
    vec2 f = fract(gp) - 0.5;
    float n = hash(cell);
    vec2 c = (hash2(cell) - 0.5) * 0.6;
    float tw = 0.5 + 0.5 * sin(uT * (1.2 + n * 3.0) + n * 60.0);
    float shape = exp(-dot(f - c, f - c) * 18.0);
    float spark = pow(tw, 14.0) * step(0.74, n) * shape * smoothstep(0.48, 0.8, bright);
    add += vec3(1.0, 0.98, 0.92) * spark * m.g * (1.1 + uEnergy * 1.6 + uBeat * 0.9);
    add += vec3(0.05, 0.07, 0.09) * m.g * smoothstep(0.55, 1.0, h);
  }

  if (m.a > 0.002) {
    off.x += m.a * sin(uv.y * 95.0 - uT * 2.6) * 0.0035;
    off.y += m.a * 0.0018 * sin(uT * 1.2 + uv.x * 50.0);
  }

  vec3 color;
  if (uRain > 0.5 && m.b > 0.01) {
    vec3 r = rain(uv, uT);
    vec3 sharp = texture2D(uImg, uv + off + r.xy).rgb;
    vec3 fog = texture2D(uBlur, uv + off).rgb;
    vec3 clear = texture2D(uImg, uv + off).rgb;
    color = mix(clear, mix(mix(clear, fog, 0.6), sharp, r.z), m.b);
    color += vec3(0.08, 0.1, 0.13) * r.z * m.b;   // 水珠边上一点反光
  } else {
    color = texture2D(uImg, uv + off).rgb;
  }
  gl_FragColor = vec4(color + add, 1.0);
}
`;

interface Props {
  image: string;
  mask: string;
  blur?: string;
  rain: boolean;
  horizon: number;
  style: React.CSSProperties;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function LivingScene({ image, mask, blur, rain, horizon, style }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) { setFailed(true); return; }
    let raf = 0, alive = true;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    } catch (err) {
      console.warn('[singinglab] 动态插画用不了，退回静态图', err);
      setFailed(true);
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const texture = (unit: number, img: TexImageSource) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };

    const engine = getEngine();
    Promise.all([loadImage(image), loadImage(mask), blur ? loadImage(blur) : Promise.resolve(null)]).then(([img, msk, bl]) => {
      if (!alive) return;
      texture(0, img);
      texture(1, msk);
      texture(2, bl ?? img);
      gl.uniform1i(u('uImg'), 0);
      gl.uniform1i(u('uMask'), 1);
      gl.uniform1i(u('uBlur'), 2);
      gl.uniform1f(u('uRain'), rain ? 1 : 0);
      gl.uniform1f(u('uHorizon'), horizon);
      canvas.dataset.ready = '1';
      let lastBeat = -1, beat = 0, energy = 0, last = performance.now();
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        if (document.hidden) return;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const dpr = Math.min(1.5, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        const song = engine.state.current;
        if (song && engine.state.playing) {
          const t = engine.time;
          const i = upper(song.downbeats, t) - 1;
          if (i !== lastBeat && i >= 0 && t - song.downbeats[i] < 0.2) beat = 1;
          lastBeat = i;
        }
        beat *= Math.exp(-dt * 3);
        energy += (engine.energy() - energy) * Math.min(1, dt * 8);
        gl.uniform1f(u('uT'), reduce ? 0 : now / 1000);
        gl.uniform1f(u('uEnergy'), energy);
        gl.uniform1f(u('uBeat'), beat);
        gl.uniform2f(u('uRes'), w, h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      raf = requestAnimationFrame(frame);
    }).catch(() => setFailed(true));
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [image, mask, blur, rain, horizon]);

  if (failed) return <img className="sl-scene-img" src={image} alt="" style={style} draggable={false} />;
  return <canvas className="sl-scene-img sl-living" ref={ref} style={style} />;
}
