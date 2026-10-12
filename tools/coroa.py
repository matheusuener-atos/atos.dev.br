# A coroa de espinhos em vetor (public/marca/atos-coroa*.svg): o contorno do original public/assets/coroa-original.png
# (branco com alfa, 512 x 512; a coroa-branca.png de 112 px e o mesmo desenho). O alfa e suavizado de leve, cortado em
# 50%, contornado pelas arestas dos pixels e simplificado (Douglas-Peucker), sem redesenhar nada. Sai um "d" num viewBox 0 0 64 64, para o menu de conta (a marca "coroa") e o pacote. Usado pelo
# tools/gerar-marca.py; precisa do Pillow no venv.

from PIL import Image, ImageFilter

ESCALA = 4
SUAVE = 2.2
TOLERANCIA = 1.6


def _rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    n = (dx * dx + dy * dy) ** 0.5 or 1e-9
    dm, im = 0, 0
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / n
        if d > dm:
            dm, im = d, i
    if dm > eps:
        return _rdp(pts[: im + 1], eps)[:-1] + _rdp(pts[im:], eps)
    return [pts[0], pts[-1]]


def caminho_da_coroa(png, lado=64):
    alfa = Image.open(png).getchannel("A")
    w, h = alfa.size
    # O original (512 px) ja tem resolucao: so uma suavizacao leve. O de 112 px e ampliado antes.
    e = 1 if w >= 400 else ESCALA
    g = alfa.resize((w * e, h * e), Image.BICUBIC) if e > 1 else alfa
    g = g.filter(ImageFilter.GaussianBlur(0.8 if e == 1 else SUAVE))
    W, H = g.size
    px = g.load()
    on = [[px[x, y] >= 128 for x in range(W)] for y in range(H)]

    def v(x, y):
        return 0 <= x < W and 0 <= y < H and on[y][x]

    # As arestas entre o cheio e o vazio, orientadas (o cheio sempre do mesmo lado): cada laco e um contorno.
    prox = {}
    for y in range(H):
        for x in range(W):
            if not on[y][x]:
                continue
            if not v(x, y - 1):
                prox.setdefault((x, y), []).append((x + 1, y))
            if not v(x + 1, y):
                prox.setdefault((x + 1, y), []).append((x + 1, y + 1))
            if not v(x, y + 1):
                prox.setdefault((x + 1, y + 1), []).append((x, y + 1))
            if not v(x - 1, y):
                prox.setdefault((x, y + 1), []).append((x, y))
    lacos = []
    while prox:
        a = next(iter(prox))
        laco, atual = [a], a
        while True:
            lista = prox[atual]
            b = lista.pop()
            if not lista:
                del prox[atual]
            if b == a:
                break
            laco.append(b)
            atual = b
        lacos.append(laco)

    s = lado / W

    def f(q):
        t = ("%.1f" % (q * s)).rstrip("0").rstrip(".")
        return "0" if t in ("-0", "") else t

    partes = []
    for laco in lacos:
        if len(laco) < 12:
            continue
        m = len(laco) // 2
        tol = 1.1 if e == 1 else TOLERANCIA
        p = _rdp(laco[: m + 1], tol)[:-1] + _rdp(laco[m:] + [laco[0]], tol)[:-1]
        partes.append("M" + " ".join(f(x) + " " + f(y) for x, y in p) + "Z")
    return "".join(partes)
