# Monta ../index.html a partir do template: embute imagens, vídeo e o motor de luz.
#   python3 fonte/montar.py     (de qualquer pasta)
import base64, os, re
F = os.path.dirname(os.path.abspath(__file__)); I = os.path.join(F, "imagens")
def uri(nome, mime): return f"data:{mime};base64," + base64.b64encode(open(os.path.join(I, nome), "rb").read()).decode()
html = open(os.path.join(F, "apresentacao-template.html"), encoding="utf-8").read()
subs = {
  "{{IMG:logo}}":     uri("logo-negativo.png", "image/png"),
  "{{IMG:hero}}":     uri("hero-vereda.webp", "image/webp"),
  "{{IMG:cogumelo}}": uri("prod-cogumelo.webp", "image/webp"),
  "{{IMG:vaso}}":     uri("prod-vaso.webp", "image/webp"),
  "{{IMG:atelie}}":   uri("prod-atelie.webp", "image/webp"),
  "{{IMG:poster}}":   uri("heroi-impressora-poster.webp", "image/webp"),
  "{{VID:webm}}":     uri("heroi-impressora.webm", "video/webm"),
  "{{VID:mp4}}":      uri("heroi-impressora.mp4", "video/mp4"),
  "{{JS:luz}}":       open(os.path.join(F, "luz.js"), encoding="utf-8").read(),
}
for k, v in subs.items():
    assert html.count(k), f"placeholder sem uso: {k}"; html = html.replace(k, v)
sobrou = re.findall(r"\{\{(IMG|VID|JS):\w+\}\}", html); assert not sobrou, sobrou
saida = os.path.join(F, "..", "index.html"); open(saida, "w", encoding="utf-8").write(html)
print(f"montado: {os.path.normpath(saida)} · {len(html)//1024} KB")
