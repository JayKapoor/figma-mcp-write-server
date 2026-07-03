"""Morph: flatten an IR tree into absolute-positioned paint leaves.

Usage: python flatten.py <captureDir>/ir.json [leaves.json]
Each leaf is one of:
  {t:text, x,y,w,h, s, fs, fw, col, fam, al, tt, lh}
  {t:rect, x,y,w,h, bg, rad, bd, z}
  {t:img,  x,y,w,h, ak, fit, rad, z}    ak = asset key into ir.assets
  {t:svg,  x,y,w,h, svg}
The builder places these absolutely, which gives pixel-accurate fidelity.
Auto-layout conversion (for editability) is a later pass.
"""
import json, sys, os


def flatten(ir):
    leaves = []

    def walk(n):
        x, y, w, h = n["box"]
        z = n.get("z")
        if "text" in n and n["text"].strip():
            f = n["font"]
            leaf = {"t": "text", "x": x, "y": y, "w": max(w, 1), "h": max(h, 1),
                    "s": n["text"][:300], "fs": f["size"], "fw": f["weight"],
                    "col": f["color"], "fam": f["family"], "al": f.get("align", "left"),
                    "tt": f.get("transform", "none")}
            lh = f.get("lh", "")
            if isinstance(lh, str) and lh.endswith("px"):
                leaf["lh"] = round(float(lh[:-2]), 1)
            leaves.append(leaf)
        elif "ak" in n or "img" in n or "bgImageUrl" in n or "video" in n:
            leaf = {"t": "img", "x": x, "y": y, "w": max(w, 1), "h": max(h, 1),
                    "ak": n.get("ak", ""), "fit": n.get("fit", "cover")}
            if n.get("radius"): leaf["rad"] = n["radius"]
            if z is not None: leaf["z"] = z
            leaves.append(leaf)
        elif "svg" in n and not n["svg"].startswith("TOO_LARGE") and len(n["svg"]) < 4000 and w >= 8 and h >= 8:
            leaves.append({"t": "svg", "x": x, "y": y, "w": w, "h": h, "svg": n["svg"]})
            return  # svg markup already contains its children
        elif "bg" in n and w >= 2 and h >= 2:
            leaf = {"t": "rect", "x": x, "y": y, "w": w, "h": h, "bg": n["bg"],
                    "rad": n.get("radius"), "bd": n.get("border")}
            if z is not None: leaf["z"] = z
            leaves.append(leaf)
        for c in n.get("children", []) or []:
            walk(c)

    walk(ir["tree"])
    # dedupe identical leaves (responsive SSR variants can double up)
    seen, uniq = set(), []
    for l in leaves:
        k = (l["t"], l["x"], l["y"], l.get("s"), l.get("bg"), l.get("ak"), l["w"])
        if k not in seen:
            seen.add(k); uniq.append(l)
    return uniq


if __name__ == "__main__":
    ir_path = sys.argv[1]
    ir = json.load(open(ir_path))
    out = flatten(ir)
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(ir_path), "leaves.json")
    json.dump(out, open(out_path, "w"))
    counts = {t: sum(1 for l in out if l["t"] == t) for t in ("text", "img", "rect", "svg")}
    print(f"{len(out)} leaves -> {out_path} "
          f"({counts['text']} text, {counts['img']} img, {counts['rect']} rect, {counts['svg']} svg)")
