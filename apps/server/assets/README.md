# Assets

- `beat-this-small.onnx`: the small model of [Beat This!](https://github.com/CPJKU/beat_this) (Foscarin, Schlüter & Widmer, ISMIR 2024; checkpoint `small0`, MIT, see `beat-this-LICENSE.txt`), exported to ONNX by `scripts/beat-this/export.py`. It reads a log-mel spectrogram (`beatThisSpectrogram` in `packages/mix`) and answers beat and downbeat odds for every 1/50 s; `src/analysis/beatModel.ts` runs it.
