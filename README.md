# dsh-singinglab：大肥鱼唱歌实验室

DeepSeek Harness 的一个插件：一个给大肥鱼唱歌用的音乐播放器。

现在（第一版进行中）能做的：

- 侧栏「唱歌」打开播放器，读歌库（学歌程序 prepare.py 的产物：每首一个目录，里面有 song.json 和 mix.mp3）
- 歌库：封面网格（B 站视频封面，第一次取时缓存）、搜索、按最近学会 / 歌名排序
- 正在播放：旋转黑胶 + 频谱环 + 小节首拍冒泡泡；封面取色的流动背景，打拍子、副歌更亮
- 歌词：逐字填色、行间弹性滚动、远处的行变淡变糊；间奏三个点；点一行跳过去；滚轮可以翻
- 播放控制：上一首 / 下一首 / 随机 / 循环 / 音量；空格暂停，← → 快退快进；关掉面板歌照样放

还没做：点歌、学歌（B 站找歌 → 本机学会）、跟她说想听什么。

## 装

在 DSH 的 profile（`<DSH_HOME>/profiles/web/package.json`）里加上：

```json
"dependencies": { "dsh-singinglab": "link:<这个目录>" },
"dsh": { "profile": { "bundles": ["…", "dsh-singinglab"] } }
```

再把这个目录链接到 `profiles/web/node_modules/dsh-singinglab`，重启 DSH。

歌库默认是 `<DSH_HOME>/dsh-singinglab/songs`。要加别的目录（只读），写进 `<DSH_HOME>/dsh-singinglab/settings.json`：

```json
{ "libraries": ["D:/somewhere/songs"] }
```

## 宿主端接口

- `GET /api/dsh-singinglab/library`：歌库列表
- `GET /api/dsh-singinglab/song?id=…`：一首歌的歌词、节拍、段落
- `GET /api/dsh-singinglab/audio?id=…`：mix.mp3，支持 Range
- `GET /api/dsh-singinglab/cover?id=…`：封面
- `GET|POST /api/dsh-singinglab/settings`：设置

## 开发

```bash
node build.mjs
```
