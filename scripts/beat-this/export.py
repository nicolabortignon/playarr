# Exports a Beat This! checkpoint (https://github.com/CPJKU/beat_this, MIT) to ONNX for the server's
# beat model (apps/server/assets/beat-this-small.onnx). The input is the log-mel spectrogram
# (1, frames, 128) that beatThisSpectrogram (packages/mix) computes; the outputs are the beat and
# downbeat logits (1, frames). Frames vary; the server feeds 30 s chunks (1500 frames), as Beat This! does.
#
#   python3 -m venv .venv && .venv/bin/pip install torch onnx "beat_this @ https://github.com/CPJKU/beat_this/archive/main.zip"
#   .venv/bin/python scripts/beat-this/export.py small0 apps/server/assets/beat-this-small.onnx
#
# The checkpoint downloads on first use (from cloud.cp.jku.at); if Python can't verify that server's
# certificate, fetch it with curl into ~/.cache/torch/hub/checkpoints/beat_this-small0.ckpt first.
import sys

import torch
from beat_this.inference import load_model

name = sys.argv[1] if len(sys.argv) > 1 else "small0"
out = sys.argv[2] if len(sys.argv) > 2 else f"beat-this-{name}.onnx"
model = load_model(name, device="cpu")


class Logits(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):
        answer = self.model(spect)
        return answer["beat"], answer["downbeat"]


torch.onnx.export(
    Logits(model).eval(),
    (torch.randn(1, 1500, 128),),
    out,
    input_names=["spect"],
    output_names=["beat", "downbeat"],
    dynamic_axes={"spect": {1: "frames"}, "beat": {1: "frames"}, "downbeat": {1: "frames"}},
    opset_version=17,
    dynamo=False,
)
print(f"{name}: {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M parameters → {out}")
