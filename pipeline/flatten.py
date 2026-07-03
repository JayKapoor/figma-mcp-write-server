"""Morph: flatten an IR tree into absolute-positioned paint leaves.

Usage: python flatten.py ir.json leaves.json
Each leaf is one of:
  {t:text, x,y,w,h, s, fs, fw, col, fam, al, tt}
  {t:rect, x,y,w,h, bg, rad, bd}
  {t:img,  x,y,w,h, src, rad}
The builder places these absolutely, which gives pixel-accurate fidelity.
Auto-layout conversion (for editability) is a later pass.
"""
import json, sys

def flatten(ir):
    leaves = []
    def walk(n):
        x, y, w, h = n["box"]
        if "text" in n and n["text"].strip():
            f = n["font"]
            leaves.append({"t": "text", "x": x, "y": y, "w": max(w, 1), "h": max(h, 1),
                           "s": n["text"][:300], "fs": f["size"], "fw": f["weight"],
                           "col": f["color"], "fam": f["family"], "al": f.get("align", "left"),
                           "tt": f.get("transform", "none")})
        elif "img" in n or "bgImageUrl" in n:
            leaves.append({"t": "img", "x": x, "y": y, "w": max(w, 1), "h": max(h, 1),
                           "src": (n.get("img") or n.get("bgImageUrl") or "")[:300], "rad": n.get("radius")})
        elif "bg" in n and w >= 2 and h >= 2:
            leaves.append({"t": "rect", "x": x, "y": y, "w": w, "h": h, "bg": n["bg"],
                           "rad": n.get("radius"), "bd": n.get("border")})
        for c in n.get("children", []) or []:
            walk(c)
    walk(ir["tree"])
    # dedupe identical leaves (responsive SSR variants can double up)
    seen, uniq = set(), []
    for l in leaves:
        k = (l["t"], l["x"], l["y"], l.get("s"), l.get("bg"), l["w"])
        if k not in seen:
            seen.add(k); uniq.append(l)
    return uniq

if __name__ == "__main__":
    ir = json.load(open(sys.argv[1]))
    out = flatten(ir)
    json.dump(out, open(sys.argv[2] if len(sys.argv) > 2 else "leaves.json", "w"))
    print(f"{len(out)} leaves ({sum(1 for l in out if l['t']=='text')} text, "
          f"{sum(1 for l in out if l['t']=='img')} img, {sum(1 for l in out if l['t']=='rect')} rect)")
