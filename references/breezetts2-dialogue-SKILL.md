---
name: breeze-tts2-dialogue
description: Write multi-speaker dialogue scripts as paste-ready JSON for the ComfyUI "Breeze TTS 2 Multi-Speaker" node. Use when the user provides character names, a bit about each character, and a target duration, and wants a conversation/argument/interview formatted for TTS generation.
source: https://raw.githubusercontent.com/Saganaki22/ComfyUI-Breeze-TTS-2/main/SKILL.md
upstream: Saganaki22/ComfyUI-Breeze-TTS-2（Apache-2.0；模型权重走 BreezeBlue 非商用许可）
fetched: 2026-10-30
---

# Breeze TTS 2 dialogue writer

> 上游原文照抄，未改动。**末尾「落地校正」一节是读 `nodes.py` / `runtime.py` 源码得出的补充**，与本文有出入时以校正节为准。

Produce a dialogue script the user can paste straight into the `text` widget of the
**Breeze TTS 2 Multi-Speaker** ComfyUI node.

## Gather from the user

1. **Characters** — a name and a short description for each (personality, speech style,
   running gags, how they talk to each other).
2. **Duration** — target length of the spoken audio.
3. Optional: language (default English), tone (comedy, drama, interview...), and any plot
   or topic the conversation must cover.

If the user already gave all of this, do not ask follow-up questions — just write.

## Output contract

- Output **only** a raw JSON array. **No markdown code fences, no commentary, no title,
  no stage directions.** The first character of your reply must be `[`.
- Exact shape: `[{"speaker": "Name", "text": "what they say"}, ...]`
- The `speaker` value must be a character name **exactly as the user gave it** (the node
  matches names forgivingly, but exact is safest). Every character must speak at least
  2–3 times.
- `text` is one or two short spoken sentences. No quotation marks inside it — if a
  character quotes someone, paraphrase. No asterisks, no emojis, no parenthetical stage
  directions like `(angrily)` — only the vocal event tags listed below.

## Length budget

Speech runs at roughly **150 words per minute**. Compute the total word budget as
`duration_minutes × 150` and split it across 10–18 turns per minute of audio
(short turns feel like real conversation; long monologues sound robotic).

| Target | Total words | Turns |
| --- | --- | --- |
| 1 min | ~150 | 10–14 |
| 1.3 min | ~200 | 14–18 |
| 2 min | ~300 | 18–26 |
| 5 min | ~750 | 40–70 |

## Vocal event tags (the ONLY markup allowed)

Confirmed tags — use only these:

- English: `(laugh)` `(cough)` `(clears throat)` `(sigh)`
- Chinese: `[笑]` `[咳嗽]` `[清嗓子]` `[叹气]`

Place them exactly where the sound should happen, e.g. `"(laugh) You paid WHAT?"`.
They count toward the words of that turn. Use them sparingly (a handful across the whole
script) and only where the character's personality calls for it. Close variants like
`(laughing)` or `(sighs)` usually also work, but prefer the confirmed forms above.
If a reaction isn't on this list, write it as normal words ("Oh come on") instead of
inventing a tag.

## Writing rules

- Make it a real exchange: characters react to, interrupt, and build on what was just
  said. Never four disconnected monologues.
- Give each character a distinct voice driven by their description — vocabulary, rhythm,
  catchphrases, running gags. Let the running gags recur and escalate.
- Dialogue is spoken aloud: prefer natural speech over written-style prose. Numbers and
  abbreviations should be written the way they're said ("fifty grand", not "50k").
- Match the requested language. For Chinese scripts use the Chinese tag set.
- End on a beat: a punchline, a callback, or someone having the last word — not mid-thought.

## Example

User asks: "Ada (a pirate captain who treats every problem like a naval battle) argues
with Bob (a nervous first mate who over-explains everything), 60 seconds."

Correct output:

[{"speaker": "Ada", "text": "(sigh) Who steered my ship into the harbor wall this time?"}, {"speaker": "Bob", "text": "Technically, captain, the harbor steered into us. The tide charts were very clear about that."}, {"speaker": "Ada", "text": "The tide charts. (laugh) Twenty years at sea and I am outmaneuvered by paperwork."}, {"speaker": "Bob", "text": "If I may, the paperwork did warn us. Twice. In bold letters."}, ...]

---

## 落地校正（读自上游 `nodes.py` / `runtime.py`，2026-10-30）

**1. 上面「150 words/min」只适用英文。** 中文按字数算：节点自己用 `3.5 帧/CJK字 ÷ 12.5 fps ≈ 0.28 s/字` 估时长；实际产出经验值 3.5–6.5 字/秒，做预算用 **4 字/秒**（每分钟约 240 字、12–18 轮、单轮 10–30 字）。

**2. 2048 上下文溢出是「单轮」的，不是整段剧本的。** `_multi_speaker_audio` 是**逐轮调 `_generate_audio` 再拼**（`_concat_audio_segments` 之间插 `pause_between_speakers` 秒静音）。单轮预算 = 台词 token + 该角色参考音频 token（12.5 token/s）+ 输出帧，共用 2048；`max_new_tokens` 也是单轮上限（1500 ≈ 120 s）。所以剧本总长不受 2048 限制，长剧本只是总耗时线性增长。

**3. 名字重复 = 硬报错。** `Duplicate speaker name 'X' (slots i and j)`；剧本里出现演员表没有的名字 → `Script uses unknown speaker(s)`。匹配键做两层：先 `lower + 空白归一 + 去 * _`，再退到「只留字母数字」（`Ali G` == `alig` == `Ali-G`）；两个演员折叠后撞键则不猜，直接按未匹配处理。

**4. 每个角色节点必须二选一，否则 `prepare` 阶段就崩：** 有音频但没逐字稿（且关了自动转写）→ `has reference audio but no transcript`；没音频且 `instruction` 空 → `no reference audio, so the instruction designs the voice`。`instruction` 留空且有音频时，走 `DEFAULT_INSTRUCTION = "Speak clearly and naturally."`（等于不改表演）。

**5. 参考音频硬上限 `MAX_REFERENCE_SECONDS = 60.0`，超了直接 raise。** 20 s 是实践甜点——token 预算的算法与取值见 `模式详解.md` §一。

**6. `seed` 按角色槽位偏移**：`turn_seed = seed + slot`（slot 从 0 起）。作用只是让各槽拿到**不同的随机数**，同一角色跨轮用同一个 `turn_seed`。它不「锚定」音色、也不「调节」节奏——音色与表演由参考音频或 `instruction` 决定。

**7. 剧本解析的两个细节：**
- 首字符是 `[` 或 `{` 就当 JSON 解析，**但** `[名字]: 台词` 这种开场被 `^\s*\[[^\]]+\]\s*:` 放行，仍走纯文本路径——所以第一行写 `[Alice]: …` 不会误判。
- 纯文本里没带名字的行**并入上一位说话人**（用空格拼），首个说话人之前出现无名字行才报 `Script must start with a speaker line`。
- JSON 键别名：说话人 `speaker/name/character/role`，台词 `text/line/content/message/dialogue`；外层可用 `script/dialogue/dialog/turns/lines/conversation` 包裹。

**8. 事件词表比本文宽一点（正则实测）**：英文还认 `laughs/laughing/coughs/sniff/sneeze/groan/gasp/hum/sighs/clears throat`；中文还认 `[笑声][叹息][抽泣][哭][喘息][呼气]`。但**只用确认过的 4 个**，别拿未测的当稳定能力。

**9. 输出固定 24 kHz 单声道**，逐轮拼接，轮间插静音；`SaveAudioAdvanced` 的 `format` 别动（改成别的会 SUCCESS 但取不回文件）。

**10. RunningHub 线上的环境坑（2026-10-30 实测，与本仓源码无关；此处只留结论与出处）：**

`auto_transcribe_if_empty` 必崩：节点内部 `whisper.py` → transformers `generation_whisper._set_language_and_task` 抛 `The generation config is outdated and is thus not compatible with the task argument to generate`。**扣费与报错形态、以及应对办法见 `故障排查.md` §三。**

**11. 四槽图不等于「必须四个人」（源码事实，源码依据与操作方案都在 `模式详解.md` §五）。**

两条只有源码里才看得到的取舍：空槽若保留默认值（`name=Alice / audio=none / instruction 空`），会先撞 `Duplicate speaker name`、再撞 `no reference audio, so the instruction designs the voice`；上限是 `MAX_SPEAKERS = 4`，要更多人得复制一张图加槽并在 `MODES.dialogue4.slots` 登记。
