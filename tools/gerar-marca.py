# Gera o kit do botao "Entrar com Atos" (public/marca/*.svg): os botoes claro, escuro e neutro, em tres tamanhos, com
# os quatro textos ("Entrar com Atos", "Continuar com Atos", "Criar conta com Atos" e o curto "Entrar", para topbars), o
# icone so (quadrado), a marca e a coroa de espinhos (atos-coroa.svg clara e atos-coroa-escura.svg: o contorno do
# original public/assets/coroa-original.png, por tools/coroa.py). O texto sai em contorno (paths): o SVG nao depende de fonte instalada.
#
#   - o texto: Inter Tight (public/assets/fontes/inter-tight.woff2, SIL Open Font License 1.1), peso 500, com o
#     espacamento e o kerning do HarfBuzz;
#   - o "A" da marca: Tinos Regular (Apache 2.0; o mesmo desenho da Liberation Serif, a Times do favicon), nas mesmas
#     proporcoes do public/assets/favicon.svg (quadrado #131312, "A" #d8d8d8).
#
# Precisa de Python com fonttools, brotli e uharfbuzz (num venv; nada global) e do Tinos do pacote @fontsource/tinos
# (npm, numa pasta temporaria):
#   python -m venv .venv && .venv/Scripts/python -m pip install fonttools brotli uharfbuzz pillow
#   npm install --prefix <tmp> @fontsource/tinos@5.1.0
#   .venv/Scripts/python tools/gerar-marca.py <tmp>/node_modules/@fontsource/tinos/files/tinos-latin-400-normal.woff2
# Imprime o caminho do "A" (viewBox 0 0 64 64), que o botao.css/HTML e o pacote usam (MARCA_A).

import io
import json
import os
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

from coroa import caminho_da_coroa

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAIDA = os.path.join(RAIZ, "public", "marca")
COROA_PNG = os.path.join(RAIZ, "public", "assets", "coroa-original.png")
INTER = os.path.join(RAIZ, "public", "assets", "fontes", "inter-tight.woff2")
PESO = 500

TEMAS = {
    # fundo, texto, borda (None: sem borda)
    "claro": ("#ffffff", "#131312", "#747775"),
    "escuro": ("#131312", "#ffffff", "#5e5e5a"),
    "neutro": ("#f2f2f0", "#131312", None),
}
MARCA_FUNDO, MARCA_A = "#131312", "#d8d8d8"
# altura, lado da marca, fonte do texto, espaco marca-texto, folga a direita
TAMANHOS = {
    "grande": (56, 32, 18, 12, 20),
    "medio": (48, 28, 16, 12, 18),
    "pequeno": (44, 24, 15, 10, 16),
}
TEXTOS = {"entrar": "Entrar com Atos", "continuar": "Continuar com Atos", "criar-conta": "Criar conta com Atos", "curto": "Entrar"}


def n(x):
    s = ("%.2f" % x).rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def caminho(glyphset, nome, escala, dx, dy):
    pen = SVGPathPen(glyphset, ntos=n)
    glyphset[nome].draw(TransformPen(pen, (escala, 0, 0, -escala, dx, dy)))
    return pen.getCommands()


def carregar_inter():
    f = TTFont(INTER)
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    bruto = buf.getvalue()
    inst = instancer.instantiateVariableFont(TTFont(io.BytesIO(bruto)), {"wght": PESO})
    face = hb.Face(bruto)
    fonte = hb.Font(face)
    fonte.set_variations({"wght": PESO})
    return inst, fonte


def texto_em_caminho(inst, fonte, texto, tamanho, x0, base):
    upm = inst["head"].unitsPerEm
    buf = hb.Buffer()
    buf.add_str(texto)
    buf.guess_segment_properties()
    hb.shape(fonte, buf, {"kern": True, "liga": True})
    ordem = inst.getGlyphOrder()
    gs = inst.getGlyphSet()
    escala = tamanho / upm
    x = 0
    partes = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        nome = ordem[info.codepoint]
        d = caminho(gs, nome, escala, x0 + (x + pos.x_offset) * escala, base - pos.y_offset * escala)
        if d:
            partes.append(d)
        x += pos.x_advance
    return " ".join(partes), x * escala


def marca_a(tinos_caminho):
    """O "A" no quadrado de 64 (como o favicon: fonte 52, centro em x=34, linha de base em y=50)."""
    f = TTFont(tinos_caminho)
    upm = f["head"].unitsPerEm
    gs = f.getGlyphSet()
    nome = f.getBestCmap()[ord("A")]
    largura = f["hmtx"][nome][0]
    escala = 52 / upm
    return caminho(gs, nome, escala, 34 - largura * escala / 2, 50)


def svg_marca(x, y, lado, d_a):
    e = lado / 64
    return ('<rect x="%s" y="%s" width="%s" height="%s" fill="%s"/>' % (n(x), n(y), n(lado), n(lado), MARCA_FUNDO) +
            '<path transform="translate(%s %s) scale(%s)" fill="%s" d="%s"/>' % (n(x), n(y), n(e), MARCA_A, d_a))


def main():
    if len(sys.argv) < 2:
        sys.exit("uso: gerar-marca.py <tinos-latin-400-normal.woff2>")
    d_a = marca_a(sys.argv[1])
    inst, fonte = carregar_inter()
    cap = inst["OS/2"].sCapHeight / inst["head"].unitsPerEm
    os.makedirs(SAIDA, exist_ok=True)
    medidas = {}
    for tema, (fundo, cor, borda) in TEMAS.items():
        for tam, (h, lado, fs, gap, dir_) in TAMANHOS.items():
            pad = (h - lado) / 2
            borda_svg = ('<rect x="0.5" y="0.5" width="%%s" height="%s" fill="none" stroke="%s"/>' % (n(h - 1), borda)) if borda else ""
            for chave, texto in TEXTOS.items():
                x0 = pad + lado + gap
                base = h / 2 + cap * fs / 2
                d, larg = texto_em_caminho(inst, fonte, texto, fs, x0, base)
                w = round(x0 + larg + dir_)
                b = (borda_svg % n(w - 1)) if borda else ""
                svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" role="img" aria-label="%s">' % (w, h, w, h, texto) +
                       "<title>%s</title>" % texto +
                       '<rect width="%d" height="%d" fill="%s"/>' % (w, h, fundo) + b +
                       svg_marca(pad, pad, lado, d_a) +
                       '<path fill="%s" d="%s"/></svg>\n' % (cor, d))
                nome = "atos-%s-%s-%s.svg" % (chave, tema, tam)
                with open(os.path.join(SAIDA, nome), "w", encoding="utf-8", newline="\n") as s:
                    s.write(svg)
                medidas[nome] = [w, h]
            # o icone so: o quadrado do tamanho da altura
            b = ('<rect x="0.5" y="0.5" width="%s" height="%s" fill="none" stroke="%s"/>' % (n(h - 1), n(h - 1), borda)) if borda else ""
            svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" role="img" aria-label="Entrar com Atos">' % (h, h, h, h) +
                   "<title>Entrar com Atos</title>" +
                   '<rect width="%d" height="%d" fill="%s"/>' % (h, h, fundo) + b + svg_marca(pad, pad, lado, d_a) + "</svg>\n")
            nome = "atos-icone-%s-%s.svg" % (tema, tam)
            with open(os.path.join(SAIDA, nome), "w", encoding="utf-8", newline="\n") as s:
                s.write(svg)
            medidas[nome] = [h, h]
    # a marca so (o quadrado com o "A"), 64 x 64
    with open(os.path.join(SAIDA, "atos-marca.svg"), "w", encoding="utf-8", newline="\n") as s:
        s.write('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="Atos"><title>Atos</title>' +
                svg_marca(0, 0, 64, d_a) + "</svg>\n")
    medidas["atos-marca.svg"] = [64, 64]
    # a coroa de espinhos (a marca "coroa" do menu de conta), sem fundo, 64 x 64: clara (fundos escuros) e escura
    # (fundos claros)
    d_coroa = caminho_da_coroa(COROA_PNG)
    for nome, cor in (("atos-coroa.svg", "#ece8e1"), ("atos-coroa-escura.svg", "#131312")):
        with open(os.path.join(SAIDA, nome), "w", encoding="utf-8", newline="\n") as s:
            s.write('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="Atos"><title>Atos</title>' +
                    '<path fill="%s" d="%s"/></svg>\n' % (cor, d_coroa))
        medidas[nome] = [64, 64]
    with open(os.path.join(SAIDA, "arquivos.json"), "w", encoding="utf-8", newline="\n") as s:
        json.dump(medidas, s, indent=1, sort_keys=True)
        s.write("\n")
    print(d_a)
    print(d_coroa)


main()
