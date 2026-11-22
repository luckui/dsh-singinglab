/**
 * 一键装学歌环境（插件自己管的独立环境，不碰用户电脑上别的 Python）：
 *   显卡  nvidia-smi 看有没有 N 卡、显存、驱动版本（驱动太老就装 cu126 的 torch）
 *   uv    从清华 PyPI 取 uv 的安装包，解出 uv 可执行文件
 *   Python  uv 装 Python 3.11（npmmirror 的 python-build-standalone 镜像）
 *   环境  uv venv
 *   torch  PyTorch 官方 CUDA 源（国内实测能连），不行再试阿里云镜像
 *   依赖  engine/requirements.txt，清华 PyPI
 *   引擎  把插件里的 engine/（Applio、MSST 的推理代码）拷到 <数据目录>/engine/code
 *   自检  导入一遍、看 CUDA 能不能用
 * 每一步都记状态（页面和她都能看），失败了说哪一步、为什么，可以从失败那步重试。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface SetupStep { id: string; name: string; state: StepState; detail?: string; sec?: number }

const TSINGHUA = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PY_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone';
const TORCH = '2.11.0';

export interface Gpu { name: string; memoryMB: number; driver: string }

export class Setup {
  steps: SetupStep[] = [
    { id: 'gpu', name: '看看显卡', state: 'pending' },
    { id: 'uv', name: '安装工具 uv', state: 'pending' },
    { id: 'python', name: '安装 Python 3.11', state: 'pending' },
    { id: 'venv', name: '建学歌专用环境', state: 'pending' },
    { id: 'torch', name: '安装 PyTorch（约 3 GB）', state: 'pending' },
    { id: 'deps', name: '安装其余依赖', state: 'pending' },
    { id: 'code', name: '放好学歌引擎', state: 'pending' },
    { id: 'check', name: '自检', state: 'pending' },
  ];
  running = false;
  gpu: Gpu | null = null;

  constructor(readonly root: string, private readonly engineSrc: string, private readonly onChange: () => void) {}

  get python(): string {
    return process.platform === 'win32' ? join(this.root, 'venv', 'Scripts', 'python.exe') : join(this.root, 'venv', 'bin', 'python');
  }
  get codeDir(): string { return join(this.root, 'code'); }
  private get uv(): string { return join(this.root, process.platform === 'win32' ? 'uv.exe' : 'uv'); }
  private get readyFile(): string { return join(this.root, 'ready.json'); }

  /** 装好了没有（自检通过过一次，且 Python 还在） */
  async ready(): Promise<{ ok: boolean; info?: any }> {
    try {
      const info = JSON.parse(await readFile(this.readyFile, 'utf8'));
      return { ok: existsSync(this.python) && existsSync(join(this.codeDir, 'applio')), info };
    } catch {
      return { ok: false };
    }
  }

  private mark(id: string, state: StepState, detail?: string, sec?: number) {
    const s = this.steps.find((x) => x.id === id)!;
    s.state = state;
    s.detail = detail;
    if (sec !== undefined) s.sec = sec;
    this.onChange();
  }

  /** 从头装（已经做好的步骤会很快过去）；同时只跑一次 */
  async install(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const s of this.steps) { s.state = 'pending'; s.detail = undefined; s.sec = undefined; }
    this.onChange();
    try {
      await mkdir(this.root, { recursive: true });
      await this.step('gpu', async () => {
        this.gpu = await detectGpu();
        return this.gpu ? `${this.gpu.name}，显存 ${Math.round(this.gpu.memoryMB / 1024)} GB，驱动 ${this.gpu.driver}` : '没找到 N 卡：能学，但会非常慢（只用 CPU）';
      });
      await this.step('uv', () => this.installUv());
      const env = this.env();
      await this.step('python', async () => { await run(this.uv, ['python', 'install', '3.11'], env); return 'Python 3.11'; });
      await this.step('venv', async () => {
        if (existsSync(this.python)) return '已经有了';
        await run(this.uv, ['venv', join(this.root, 'venv'), '--python', '3.11'], env);
        return '';
      });
      await this.step('torch', async () => {
        const flavor = !this.gpu ? 'cpu' : Number(this.gpu.driver.split('.')[0]) >= 570 ? 'cu128' : 'cu126';
        // 已经装了对的那种就跳过；装错了（比如以前没认出显卡、装成了 CPU 版）就换掉
        const have = await run(this.python, ['-c', 'import torch; print(torch.__version__)'], env).then((o) => o.trim(), () => '');
        if (have.startsWith(TORCH) && have.includes(`+${flavor}`)) return `PyTorch ${have}（已经有了）`;
        const pkgs = [`torch==${TORCH}`, `torchaudio==${TORCH}`];
        const base = ['pip', 'install', '--python', this.python, ...pkgs, ...(have ? ['--reinstall-package', 'torch', '--reinstall-package', 'torchaudio'] : [])];
        try {
          await run(this.uv, [...base, '--index-url', `https://download.pytorch.org/whl/${flavor}`], env);
        } catch {
          await run(this.uv, [...base, '--index-url', TSINGHUA, '--find-links', `https://mirrors.aliyun.com/pytorch-wheels/${flavor}/`], env);
        }
        return `PyTorch ${TORCH}（${flavor}）`;
      });
      await this.step('deps', async () => {
        await run(this.uv, ['pip', 'install', '--python', this.python, '-r', join(this.engineSrc, 'requirements.txt'), '--index-url', TSINGHUA], env);
        // ffmpeg：用 imageio-ffmpeg 包里自带的那个，放到 engine/bin 下叫 ffmpeg，学歌时加进 PATH
        const ff = (await run(this.python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], env)).trim().split(/\r?\n/).pop()!.trim();
        await mkdir(join(this.root, 'bin'), { recursive: true });
        const ffTo = join(this.root, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
        await copyFile(ff, ffTo);
        if (process.platform !== 'win32') await chmod(ffTo, 0o755);
        // 下载缓存和环境一样大（约 5 GB），装完就清掉
        await run(this.uv, ['cache', 'clean'], env).catch(() => '');
        return '';
      });
      await this.step('code', async () => {
        await rm(this.codeDir, { recursive: true, force: true });
        await cp(this.engineSrc, this.codeDir, { recursive: true });
        return '';
      });
      await this.step('check', async () => {
        const out = await run(this.python, ['-c', CHECK], env);
        const info = JSON.parse(out.trim().split('\n').pop()!);
        await writeFile(this.readyFile, JSON.stringify({ ...info, at: Date.now() }, null, 2));
        return info.cuda ? `能用显卡：${info.device}` : '只能用 CPU（会很慢）';
      });
    } finally {
      this.running = false;
      this.onChange();
    }
  }

  private async step(id: string, body: () => Promise<string>): Promise<void> {
    const t = Date.now();
    this.mark(id, 'running');
    try {
      const detail = await body();
      this.mark(id, 'done', detail, Math.round((Date.now() - t) / 1000));
    } catch (err) {
      this.mark(id, 'failed', (err as Error).message.slice(-400), Math.round((Date.now() - t) / 1000));
      throw err;
    }
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      UV_PYTHON_INSTALL_MIRROR: PY_MIRROR,
      UV_PYTHON_INSTALL_DIR: join(this.root, 'python'),
      UV_CACHE_DIR: join(this.root, 'uv-cache'),
      UV_LINK_MODE: 'copy',
      UV_HTTP_TIMEOUT: '120',
      PYTHONUTF8: '1',
    };
  }

  /** uv 的安装包（wheel）就是个 zip，里面有 uv 可执行文件 */
  private async installUv(): Promise<string> {
    if (existsSync(this.uv)) return '已经有了';
    const tag = process.platform === 'win32' ? 'win_amd64' : process.arch === 'arm64' ? 'manylinux_2_17_aarch64' : 'manylinux_2_17_x86_64';
    const index = await (await fetch(`${TSINGHUA}/uv/`, { signal: AbortSignal.timeout(30_000) })).text();
    const links = [...index.matchAll(/href="([^"]+\/(uv-([\d.]+)-py3-none-[^"#]*?\.whl))(#[^"]*)?"/g)].filter((m) => m[2].includes(tag));
    const last = links.at(-1);
    if (!last) throw new Error(`清华源上找不到 uv 的安装包（${tag}）`);
    const url = new URL(last[1], `${TSINGHUA}/uv/`).href;
    const zip = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(180_000) })).arrayBuffer());
    const want = process.platform === 'win32' ? /\/scripts\/uv\.exe$/ : /\/scripts\/uv$/;
    const bin = unzipOne(zip, (name) => want.test(name));
    if (!bin) throw new Error('uv 安装包里没找到 uv');
    await writeFile(this.uv, bin, { mode: 0o755 });
    return `uv ${last[3]}`;
  }
}

const CHECK = `
import json, torch, librosa, faiss, faster_whisper, einops, rotary_embedding_torch, PoPE_pytorch, ml_collections, transformers
ok = torch.cuda.is_available()
print(json.dumps({"torch": torch.__version__, "cuda": ok, "device": torch.cuda.get_device_name(0) if ok else None}))
`;

/** nvidia-smi 不一定在 PATH 里：WSL 在 /usr/lib/wsl/lib，Windows 在 System32 */
const NVIDIA_SMI = ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];

async function detectGpu(): Promise<Gpu | null> {
  for (const smi of NVIDIA_SMI) {
    try {
      const out = await run(smi, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], process.env);
      const rows = out.trim().split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim()));
      // 设了 CUDA_VISIBLE_DEVICES 就看它指的那一块
      const pick = Number(process.env.CUDA_VISIBLE_DEVICES?.split(',')[0]);
      const [name, mem, driver] = rows[Number.isInteger(pick) && rows[pick] ? pick : 0];
      if (name) return { name, memoryMB: Number(mem) || 0, driver };
    } catch { /* 换下一个位置 */ }
  }
  return null;
}

/** 跑一个命令，成功返回输出；失败带上最后几行 */
export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out = (out + c).slice(-20000); });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { err = (err + c).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd.split(/[\\/]/).pop()} 失败（${code}）：${(err || out).trim().split('\n').slice(-6).join(' / ')}`))));
  });
}

/** 从 zip 里取一个文件（只支持 stored / deflate，够 wheel 用） */
export function unzipOne(zip: Buffer, match: (name: string) => boolean): Buffer | null {
  // 找中央目录结尾
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (match(name)) {
      const lNameLen = zip.readUInt16LE(local + 26), lExtraLen = zip.readUInt16LE(local + 28);
      const data = zip.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
