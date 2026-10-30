# 空间 IR · 来源与用法

`fx` 模式（音频→场景音）用的卷积混响脉冲响应。**17 个真实空间**，全部来自 **OpenAIR**。这 17 条支撑 17 个空间预设；通信与音色那 11 个预设里另有 6 个复用其中 2 条（`hall` / `cathedral-big`）做房间感。

## 一、来源与许可

| 项 | 内容 |
|---|---|
| 数据集 | OpenAIR — <https://www.openairlib.net/> |
| 托管 | University of York 直连目录 `https://webfiles.york.ac.uk/OPENAIR/IRs/`，**不用注册、不用登录** |
| 许可 | **CC BY 4.0** — 可商用、可修改，**必须署名** |
| 署名写法 | `Impulse responses: OpenAIR, University of York (CC BY 4.0)` + 各空间原始录音者（见该空间目录里的 `Read Me.txt`） |
| 抓取日期 | 2026-10-30 |

**为什么要署名**：CC BY 4.0 的唯一硬约束。交付给客户的成片如果对外发布，片尾或说明里带上这一行即可。要彻底免署名就得找 CC0 的 IR，OpenAIR 不是。

GitHub 上没有现成的影视 IR 包，能查到的是索引和下载脚本；真正带 wav 的是上面这个 York 直连目录。参考索引仓库：`Graphi07/room-impulse-responses`（621★，各数据集的下载脚本，含 `get_openair.sh`）。

## 二、这 17 个是什么状态

统一下载后做过四步处理，改动不可逆，重新抓取要重跑一遍：

1. **B-format 转 W 通道**：部分空间只提供 4 声道 B-format（W/X/Y/Z），取第 0 声道 W 当单声道 IR。立体感靠后续处理，不靠 IR。
2. **统一 48 kHz / 2 声道 / pcm_f32le**：48k 是 `afir` 卷积的固定工作采样率，干声进来先重采样到 48k。
3. **限长 10 s + 尾部 0.35 s 淡出**：超过 10 s 的截断，硬切会产生咔哒声，所以补淡出。
4. **能量归一**：让卷积不再掉 40 dB（见下节）。

清单和每条 IR 的补偿增益在 `irs.json`，别手改数字——那些值是用粉噪实测出来的。

## 三、afir 的三个坑（实测，2026-10-30）

1. **`dry` 和 `wet` 不是混音比，是乘性增益，任一置 0 直接静音。**
   `dry=1:wet=0` → 全静音（-91 dB），`dry=0:wet=1` 也一样。实测输出电平 = 卷积结果 × (dry × wet)：`dry=2:wet=1` 与 `dry=1:wet=2` 输出完全相同（都 +6 dB）。所以只能取 `dry=1:wet=10`（+20 dB），剩下的增益用 `volume` 补。

2. **输出会截断到干声长度，混响尾巴被吃掉。**
   干声 2 s + IR 3 s → 输出正好 2.000 s，尾巴没了。必须先 `apad=pad_dur=<尾巴秒数>` 再进 afir，否则场景音听着"干完就断"。

3. **卷积本身衰减 40 dB 左右，必须补。**
   归一化的 IR 能量摊在几秒里，直接卷积出来的湿声比干声低 40 dB 上下，听起来像没加混响。`irs.json` 里的 `makeup_db` 是拿粉噪（-37.2 dB RMS）逐条实测的补偿值，范围 +7.3 ~ +23.0 dB，跟混响长度正相关。换 IR、换 ffmpeg 版本都要重测。

## 四、标准接线

```bash
ffmpeg -y -i 干声.mp3 -i assets/irs/york-minster.wav -filter_complex \
"[0:a]aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=7,asplit=2[d1][d2];
 [d1][1:a]afir=dry=1:wet=10,volume=<wet_linear>[w];
 [d2]volume=<dry_linear>[d];
 [d][w]amix=inputs=2:normalize=0,alimiter=limit=0.94[o]" \
-map "[o]" -ar 48000 -c:a libmp3lame -b:a 192k 输出.mp3
```

其中 `wet_linear = 湿度 × 10^(makeup_db/20)`，`dry_linear = 1 − 湿度`。`apad` 的秒数取 IR 长度（`irs.json` 的 `seconds`），留足尾巴。

## 五、备选源（还没下，记在这儿）

| 源 | 内容 | 许可 | 状态 |
|---|---|---|---|
| EchoThief — <https://www.echothief.com/downloads/> | 100+ 北美空间，洞穴 / 隧道 / 楼梯井 / 冰河 / 堡垒，**影视感比 OpenAIR 强** | 待核实（站点未明示，用前必须确认是否 CC BY） | 单个 zip 29 MB，一次全拿 |
| MIT IR Survey — <https://mcdermottlab.mit.edu/Reverb/IR_Survey.html> | 271 条单声道 RIR，各不同地点 | 未标注 | 许可不明，商用慎用 |
| `ShanonPearce/ASH-IR-Dataset` | 双耳 BRIR，做 3D 环绕/耳机空间 | **CC BY-NC-SA**（禁商用） | 做内部测试可以，交付不行 |
| C4DM RIR database | 468 条，3 个大空间 | CC BY-NC-SA（禁商用） | 同上 |

要补"地下停车场、地铁站、地下通道、冰川"这类，EchoThief 是最省事的一步；先用前先确认许可。
