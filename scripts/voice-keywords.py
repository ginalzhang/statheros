"""Tokenize resources/voice/keywords_raw.txt with the KWS model's BPE (equivalent to `sherpa-onnx-cli text2token`).

Run after changing the wake phrase:  python3 -m venv .cache/spvenv && .cache/spvenv/bin/pip install sentencepiece
  .cache/spvenv/bin/python -I scripts/voice-keywords.py resources/voice/models/kws/bpe.model resources/voice/keywords_raw.txt resources/voice/keywords.txt
Each raw line: TEXT [@DISPLAY] [:boost] [#threshold]. Pieces come from the BPE model; never hand-write them.
"""
import sys
import sentencepiece as spm

bpe, raw, out = sys.argv[1:4]
sp = spm.SentencePieceProcessor(model_file=bpe)
lines = []
for line in open(raw, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    words, extras = [], []
    for token in line.split():
        (extras if token[0] in "@:#" else words).append(token)
    pieces = sp.encode(" ".join(words).upper(), out_type=str)
    lines.append(" ".join(pieces + extras))
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(f"wrote {len(lines)} keywords to {out}")
