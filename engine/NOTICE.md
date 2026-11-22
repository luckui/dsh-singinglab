# 第三方代码

`engine/` 里是学歌要用的两个开源项目的**推理部分**，原样拷贝（没有改动），只保留推理用到的文件：

| 目录 | 来源 | 许可证 |
|---|---|---|
| `applio/` | [Applio](https://github.com/IAHispano/Applio)（RVC 推理、RMVPE 音高） | MIT，见 `applio/LICENSE` |
| `msst/` | [Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training)（BS/Mel-Band RoFormer 分离） | MIT，见 `msst/LICENSE` |

模型文件不在这里，由插件的「模型货架」按需下载，各模型的许可证写在 `assets/catalog.json`。
